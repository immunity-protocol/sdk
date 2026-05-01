import { type ChainAntibody, decodeAntibody } from "../settlement/decode.js";
import type { RegistryClient } from "../settlement/registry-client.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import type { Antibody, Hex32 } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { isAddress, normalizeAddress } from "../util/address.js";
import { createLogger } from "../util/logger.js";
import { NegativeMatcherCache } from "./negative-cache.js";

const log = createLogger("immunity:registry-lookup");

export interface Tier2LookupResult {
  exists: boolean;
  antibody?: Antibody;
}

/**
 * Tier-2 lookup: resolve antibodies on cache miss by querying the Registry's
 * `matcherIndex` directly. Reuses the existing RegistryClient provider — no
 * separate connection — and gates RPC traffic via a short negative cache
 * for genuinely-absent matcher hashes.
 *
 * The candidate-hash extractor is intentionally narrow: only hashes the SDK
 * can canonicalize without context (address-shaped tx fields). SEMANTIC and
 * BYTECODE matchers depend on richer state already covered by Tier 1, so
 * Tier 2 skips them.
 */
export class Tier2LookupClient {
  constructor(
    private readonly registry: RegistryClient,
    private readonly defaultChainId: number,
    public readonly negativeCache: NegativeMatcherCache = new NegativeMatcherCache(),
  ) {}

  async getAntibodyByMatcherHash(matcherHash: Hex32): Promise<Tier2LookupResult> {
    if (this.negativeCache.isCachedAsAbsent(matcherHash)) {
      return { exists: false };
    }
    const raw = (await this.registry.contract.getAntibodyByMatcherHash(matcherHash)) as
      | { antibody: ChainAntibody; exists: boolean }
      | [ChainAntibody, boolean];

    const antibody = Array.isArray(raw) ? raw[0] : raw.antibody;
    const exists = Array.isArray(raw) ? raw[1] : raw.exists;

    if (!exists) {
      this.negativeCache.markAbsent(matcherHash);
      return { exists: false };
    }

    const keccakId = (await this.registry.contract.matcherIndex(matcherHash)) as Hex32;
    return { exists: true, antibody: decodeAntibody(antibody, keccakId) };
  }

  async firstMatch(tx: ProposedTx | null, context: CheckContext): Promise<Antibody | null> {
    const hashes = computeCandidateMatcherHashes(tx, context, this.defaultChainId);
    for (const hash of hashes) {
      const result = await this.getAntibodyByMatcherHash(hash).catch((err) => {
        log.warn("Tier-2 lookup failed; falling through", err);
        return { exists: false } as Tier2LookupResult;
      });
      if (!result.exists || !result.antibody) continue;
      // Mirror the Tier-1 matcher filter: only ACTIVE entries are real
      // matches. The Registry contract keeps SLASHED / EXPIRED rows
      // in `getAntibodyByMatcherHash` for audit trail, but acting on
      // them would resurrect retired threats — fall through to the next
      // candidate (or eventually to the policy fork).
      if (result.antibody.status !== "ACTIVE") {
        log.debug("Tier-2 hit ignored (status != ACTIVE)", {
          keccakId: result.antibody.keccakId,
          status: result.antibody.status,
        });
        continue;
      }
      return result.antibody;
    }
    return null;
  }
}

/**
 * Yields the matcher hashes worth probing on Tier 2 for a given tx + context.
 * Order matters: most-likely-to-match first so we short-circuit on the first
 * hit. Today this means address-shaped lookups only — bytecode/graph/semantic
 * are richer matchers handled in Tier 1 already.
 */
export function computeCandidateMatcherHashes(
  tx: ProposedTx | null,
  context: CheckContext,
  defaultChainId: number,
): Hex32[] {
  const seen = new Set<Hex32>();
  const out: Hex32[] = [];

  function pushAddress(target: string | undefined, chainId: number): void {
    if (!target || !isAddress(target)) return;
    const hash = hashAddressMatcher({ chainId, target: normalizeAddress(target) });
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push(hash);
  }

  if (tx) {
    const chainId = tx.chainId ?? defaultChainId;
    pushAddress(tx.to, chainId);
  }

  const counterpartyId = context.counterparty?.id;
  if (counterpartyId) {
    pushAddress(counterpartyId, tx?.chainId ?? defaultChainId);
  }

  return out;
}
