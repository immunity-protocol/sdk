import { keccak256 } from "ethers";
import type { AntibodyCache } from "../cache/cache.js";
import { hashBytecodeMatcher } from "../keccak/matchers/bytecode.js";
import type { Address, Antibody, Hex32 } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import type { Matcher, MatchHit, MatchProbe } from "./matcher.js";

/**
 * Resolves the runtime bytecode at a given (chainId, address). The matcher
 * caches results in-process so repeat probes against the same contract
 * cost zero RPCs. Pass a mock fetcher in tests.
 */
export type CodeFetcher = (chainId: number, address: Address) => Promise<`0x${string}`>;

/**
 * BytecodeMatcher: clone-detection via runtime-bytecode hash.
 *
 * Probe path: lookup `tx.to` -> fetch runtime bytecode (one RPC, cached) ->
 * keccak256 -> match against the index of `BYTECODE`-type antibodies.
 *
 * Empty code (EOA / never-deployed addresses) short-circuits without
 * touching the RPC.
 */
export class BytecodeMatcher implements Matcher {
  readonly name = "BYTECODE";
  readonly priority = 40;

  private readonly index = new Map<Hex32, Antibody>();
  private readonly codeCache = new Map<string, Hex32>();
  private readonly defaultChainId: number;
  private readonly fetcher: CodeFetcher;

  constructor(defaultChainId: number, fetcher: CodeFetcher) {
    this.defaultChainId = defaultChainId;
    this.fetcher = fetcher;
  }

  attach(cache: AntibodyCache): void {
    for (const ab of cache.values()) this.tryIndex(ab);
    cache.subscribe((kind, ab) => {
      if (kind === "put") this.tryIndex(ab);
      else this.tryUnindex(ab);
    });
  }

  async match(probe: MatchProbe): Promise<MatchHit | null> {
    if (!probe.tx?.to) return null;
    const chainId = probe.tx.chainId ?? this.defaultChainId;
    const target = normalizeAddress(probe.tx.to);
    const cacheKey = `${chainId}:${target}`;

    let bytecodeHash = this.codeCache.get(cacheKey);
    if (!bytecodeHash) {
      const code = await this.fetcher(chainId, target);
      if (code === "0x" || code === "0x0") return null;
      bytecodeHash = keccak256(code) as Hex32;
      this.codeCache.set(cacheKey, bytecodeHash);
    }

    const ab = this.index.get(bytecodeHash);
    if (ab && ab.status === "ACTIVE") {
      return {
        antibody: ab,
        matcherName: this.name,
        reason: `bytecode of ${target} matches ${ab.immId}`,
      };
    }
    return null;
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "BYTECODE" || !ab.seed || ab.seed.abType !== "BYTECODE") return;
    const expected = hashBytecodeMatcher({ bytecodeHash: ab.seed.bytecodeHash });
    if (expected !== ab.primaryMatcherHash) return;
    this.index.set(ab.seed.bytecodeHash, ab);
  }

  private tryUnindex(ab: Antibody): void {
    if (ab.abType !== "BYTECODE" || !ab.seed || ab.seed.abType !== "BYTECODE") return;
    this.index.delete(ab.seed.bytecodeHash);
  }
}
