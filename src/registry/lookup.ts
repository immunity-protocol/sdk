import type { AntibodyCache } from "../cache/cache.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../keccak/matchers/call-pattern.js";
import type { CodeFetcher } from "../matchers/bytecode.js";
import type { MatchProbe } from "../matchers/matcher.js";
import { extractCounterparties } from "../tx/extractCounterparties.js";
import type { Address, Antibody, Hex32 } from "../types/antibody.js";
import { keccak256 } from "ethers";
import { type RawAntibody, type RawEnforcementInputs, decodeAntibody } from "./decode.js";
import type { NegativeMatcherCache } from "./negative-cache.js";

/** The subset of `ImmunityRegistry` view methods the SDK reads. */
export interface RegistryReads {
  getEnforcementInputs(antibodyId: Hex32): Promise<RawEnforcementInputs>;
  getAntibody(keccakId: Hex32): Promise<RawAntibody>;
  getAntibodiesByMatcher(matcherHash: Hex32): Promise<readonly Hex32[]>;
  corroborationK(): Promise<bigint | number>;
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

/**
 * Tier-2 on-chain registry lookup.
 *
 * Derives the deterministic matcher hashes the chain might hold for a probe —
 * reusing the SAME keccak primitives the Tier-1 matchers use — queries
 * `getAntibodiesByMatcher`, and hydrates the results into the cache so the next
 * probe resolves at Tier-1 (a Tier-2 hit is a one-time cost).
 *
 * Only ADDRESS, CALL_PATTERN and BYTECODE are Tier-2-queryable. SEMANTIC markers
 * are not reverse-searchable on-chain and GRAPH taint sets need off-chain
 * enrichment, so those two resolve via Tier-1 cache or Tier-3 (CRE) only.
 */
export class Tier2Lookup {
  private readonly reads: RegistryReads;
  private readonly cache: AntibodyCache;
  private readonly negativeCache: NegativeMatcherCache;
  private readonly codeFetcher: CodeFetcher;
  private readonly defaultChainId: number;

  constructor(opts: {
    reads: RegistryReads;
    cache: AntibodyCache;
    negativeCache: NegativeMatcherCache;
    codeFetcher: CodeFetcher;
    defaultChainId: number;
  }) {
    this.reads = opts.reads;
    this.cache = opts.cache;
    this.negativeCache = opts.negativeCache;
    this.codeFetcher = opts.codeFetcher;
    this.defaultChainId = opts.defaultChainId;
  }

  /** Candidate matcher hashes for a probe (ADDRESS + CALL_PATTERN + BYTECODE). */
  async candidateMatcherHashes(probe: MatchProbe): Promise<Hex32[]> {
    const chainId = probe.tx?.chainId ?? this.defaultChainId;
    const hashes = new Set<Hex32>();

    for (const addr of this.candidateAddresses(probe)) {
      hashes.add(hashAddressMatcher({ chainId, target: addr }));
    }

    const callPattern = this.callPatternOf(probe);
    if (callPattern) {
      const { target, selector, argsTemplate } = callPattern;
      hashes.add(hashCallPatternMatcher({ chainId, target, selector, argsTemplate }));
      // Selector-only fallback (argsTemplate "0x"), matching the Tier-1 matcher.
      hashes.add(hashCallPatternMatcher({ chainId, target, selector, argsTemplate: "0x" }));
    }

    const bytecodeHash = await this.bytecodeHashOf(probe, chainId);
    if (bytecodeHash) hashes.add(hashBytecodeMatcher({ bytecodeHash }));

    return [...hashes];
  }

  /**
   * Query the corroboration set for a matcher hash. Empty → mark absent in the
   * negative cache and return `[]`. Non-empty → evict the absent entry and
   * return the keccakIds. An RPC error PROPAGATES (so the caller can fail-closed
   * downstream) — it is never swallowed into a false "no antibody".
   */
  async lookupMatcher(matcherHash: Hex32): Promise<Hex32[]> {
    const ids = await this.reads.getAntibodiesByMatcher(matcherHash);
    if (ids.length === 0) {
      this.negativeCache.markAbsent(matcherHash);
      return [];
    }
    this.negativeCache.evict(matcherHash);
    return ids.map((id) => id.toLowerCase() as Hex32);
  }

  /** Fetch + decode an antibody and put it in the cache so Tier-1 sees it next. */
  async hydrate(keccakId: Hex32): Promise<Antibody> {
    const raw = await this.reads.getAntibody(keccakId);
    const ab = decodeAntibody(keccakId, raw);
    this.cache.put(ab);
    return ab;
  }

  private candidateAddresses(probe: MatchProbe): Address[] {
    const out = new Set<Address>();
    if (probe.tx?.to) out.add(probe.tx.to.toLowerCase() as Address);
    for (const a of extractCounterparties(probe.tx)) out.add(a);
    const cp = probe.context.counterparty?.id;
    if (cp && EVM_ADDR_RE.test(cp)) out.add(cp.toLowerCase() as Address);
    return [...out];
  }

  private callPatternOf(
    probe: MatchProbe,
  ): { target: Address; selector: `0x${string}`; argsTemplate: `0x${string}` } | null {
    const tx = probe.tx;
    if (!tx?.to || !tx.data || tx.data.length < 10) return null;
    const selector = tx.data.slice(0, 10);
    if (!SELECTOR_RE.test(selector)) return null;
    return {
      target: tx.to.toLowerCase() as Address,
      selector: selector as `0x${string}`,
      argsTemplate: `0x${tx.data.slice(10)}` as `0x${string}`,
    };
  }

  private async bytecodeHashOf(probe: MatchProbe, chainId: number): Promise<Hex32 | null> {
    if (!probe.tx?.to) return null;
    const code = await this.codeFetcher(chainId, probe.tx.to.toLowerCase() as Address);
    if (code === "0x" || code === "0x0") return null;
    return keccak256(code) as Hex32;
  }
}
