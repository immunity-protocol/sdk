import type { AntibodyCache } from "../cache/cache.js";
import type { CodeFetcher } from "../matchers/bytecode.js";
import type { MatcherRegistry, MatchProbe } from "../matchers/matcher.js";
import type { Antibody, Hex32 } from "../types/antibody.js";
import type { EnforcementInputs } from "../types/enforcement.js";
import { decodeEnforcementInputs } from "./decode.js";
import { type RegistryReads, Tier2Lookup } from "./lookup.js";
import type { NegativeMatcherCache } from "./negative-cache.js";

export type EnforcementTier = "hard-block" | "advisory" | "none";

/**
 * The two-speed enforcement rule, as a pure function.
 *
 * Hard-block IFF `corroboration >= k` OR `isSeeded`; otherwise advisory. Dead
 * antibodies (SLASHED/EXPIRED/past-TTL) are neither — they return `none`.
 *
 * It deliberately does NOT branch on `status === "ACTIVE"`: a later maturation
 * pass can reach ACTIVE via time/volume WITHOUT corroboration, and that must
 * never grant censorship power. So an ACTIVE-but-uncorroborated antibody is
 * advisory, and CHALLENGED falls out correctly for free — corroborated/seeded
 * stays hard-block during a challenge, uncorroborated is advisory.
 */
export function classifyEnforcement(
  i: EnforcementInputs,
  k: number,
  nowSec: bigint,
): EnforcementTier {
  if (i.status === "SLASHED" || i.status === "EXPIRED") return "none";
  if (i.expiresAt !== 0n && i.expiresAt <= nowSec) return "none";
  if (i.isSeeded || i.corroboration >= k) return "hard-block";
  return "advisory";
}

const TIER_RANK: Record<EnforcementTier, number> = { none: 0, advisory: 1, "hard-block": 2 };

function strongest(a: EnforcementTier, b: EnforcementTier): EnforcementTier {
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

export interface EnforcementResolution {
  tier: EnforcementTier;
  antibodies: Antibody[];
  inputs: EnforcementInputs[];
  source: "cache" | "registry" | "none";
}

/**
 * Read-only resolver that combines Tier-1 (local cache via the matchers) and
 * Tier-2 (on-chain registry lookup) into a single enforcement decision. The
 * cohesive S4 deliverable S5's `check()` will call. It writes nothing on-chain
 * and decides no policy actions — it only derives the enforcement *tier*.
 */
export class EnforcementResolver {
  private readonly reads: RegistryReads;
  private readonly matchers: MatcherRegistry;
  private readonly negativeCache: NegativeMatcherCache;
  private readonly lookup: Tier2Lookup;
  private readonly now: () => number;
  private readonly inputsTtlMs: number;

  private k: number | null = null;
  private readonly inputsCache = new Map<Hex32, { value: EnforcementInputs; expiresAt: number }>();

  constructor(opts: {
    reads: RegistryReads;
    matchers: MatcherRegistry;
    cache: AntibodyCache;
    negativeCache: NegativeMatcherCache;
    codeFetcher: CodeFetcher;
    chainId: number;
    now?: () => number;
    inputsTtlMs?: number;
  }) {
    this.reads = opts.reads;
    this.matchers = opts.matchers;
    this.negativeCache = opts.negativeCache;
    this.now = opts.now ?? (() => Date.now());
    this.inputsTtlMs = opts.inputsTtlMs ?? 30_000;
    this.lookup = new Tier2Lookup({
      reads: opts.reads,
      cache: opts.cache,
      negativeCache: opts.negativeCache,
      codeFetcher: opts.codeFetcher,
      defaultChainId: opts.chainId,
    });
  }

  async resolve(probe: MatchProbe): Promise<EnforcementResolution> {
    const k = await this.corroborationK();
    // Coarse wall-clock seconds. TTL comparisons are intentionally coarse, so a
    // few seconds of node clock skew is immaterial; we do not spend an RPC on
    // block time for this.
    const nowSec = BigInt(Math.floor(this.now() / 1000));

    // Tier-1: local cache (priority-ordered, short-circuits cheap-first).
    const hit = await this.matchers.matchFirst(probe);
    if (hit) {
      const inputs = await this.enforcementInputs(hit.antibody.keccakId);
      return {
        tier: classifyEnforcement(inputs, k, nowSec),
        antibodies: [hit.antibody],
        inputs: [inputs],
        source: "cache",
      };
    }

    // Tier-2: on-chain registry lookup over candidate matcher hashes.
    const hashes = await this.lookup.candidateMatcherHashes(probe);
    const antibodies: Antibody[] = [];
    const inputs: EnforcementInputs[] = [];
    const seen = new Set<Hex32>();
    let tier: EnforcementTier = "none";
    let matched = false;

    for (const hash of hashes) {
      if (this.negativeCache.isCachedAsAbsent(hash)) continue;
      // Lookup errors propagate by design (so S5 can fail-closed) — not swallowed.
      const ids = await this.lookup.lookupMatcher(hash);
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        matched = true;
        const ab = await this.lookup.hydrate(id);
        const i = await this.enforcementInputs(id);
        antibodies.push(ab);
        inputs.push(i);
        tier = strongest(tier, classifyEnforcement(i, k, nowSec));
      }
    }

    if (!matched) return { tier: "none", antibodies: [], inputs: [], source: "none" };
    return { tier, antibodies, inputs, source: "registry" };
  }

  /** Governance param read once and cached. */
  private async corroborationK(): Promise<number> {
    if (this.k === null) this.k = Number(await this.reads.corroborationK());
    return this.k;
  }

  /** `getEnforcementInputs` with a brief TTL — corroboration changes slowly. */
  private async enforcementInputs(antibodyId: Hex32): Promise<EnforcementInputs> {
    const cached = this.inputsCache.get(antibodyId);
    if (cached && this.now() < cached.expiresAt) return cached.value;
    const value = decodeEnforcementInputs(await this.reads.getEnforcementInputs(antibodyId));
    this.inputsCache.set(antibodyId, { value, expiresAt: this.now() + this.inputsTtlMs });
    return value;
  }
}
