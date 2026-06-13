import { getBytes, keccak256 } from "ethers";
import type { AntibodyCache } from "../cache/cache.js";
import { hashCallPatternMatcher } from "../keccak/matchers/call-pattern.js";
import { type Antibody, isLiveAntibody } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import type { MatchHit, MatchProbe, Matcher } from "./matcher.js";
import { logSeedHashMismatch } from "./seed-hash-log.js";

/**
 * CallPatternMatcher: looks up against `(chainId, target, selector, argsTemplateHash)`.
 *
 * v1 supports exact-match on argsTemplate (the bytes following the selector
 * in calldata) plus a selector-only mode (`argsTemplate == "0x"`). Two
 * lookups per probe: an exact match on the calldata's full args, and a
 * fallback selector-only match.
 *
 * argsTemplateHash is `keccak256(argsTemplate)`, matching the contract-side
 * canonicalization in `hashCallPatternMatcher`.
 */
export class CallPatternMatcher implements Matcher {
  readonly name = "CALL_PATTERN";
  readonly priority = 20;

  private readonly index = new Map<string, Antibody>();
  private readonly defaultChainId: number;

  constructor(defaultChainId: number) {
    this.defaultChainId = defaultChainId;
  }

  attach(cache: AntibodyCache): void {
    for (const ab of cache.values()) this.tryIndex(ab);
    cache.subscribe((kind, ab) => {
      if (kind === "put") this.tryIndex(ab);
      else this.tryUnindex(ab);
    });
  }

  async match(probe: MatchProbe): Promise<MatchHit | null> {
    if (!probe.tx?.to || !probe.tx.data || probe.tx.data.length < 10) return null;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const chainId = probe.tx.chainId ?? this.defaultChainId;
    const target = normalizeAddress(probe.tx.to);
    const selector = probe.tx.data.slice(0, 10) as `0x${string}`;
    const argsTemplate = `0x${probe.tx.data.slice(10)}` as `0x${string}`;

    // Surface any LIVE antibody; block-vs-advisory is decided read-side.
    const exact = this.index.get(this.indexKey(chainId, target, selector, argsTemplate));
    if (exact && isLiveAntibody(exact, nowSec)) {
      return {
        antibody: exact,
        matcherName: this.name,
        reason: `call ${selector} to ${target} matches ${exact.immId}`,
      };
    }

    const selectorOnly = this.index.get(this.indexKey(chainId, target, selector, "0x"));
    if (selectorOnly && isLiveAntibody(selectorOnly, nowSec)) {
      return {
        antibody: selectorOnly,
        matcherName: this.name,
        reason: `selector ${selector} to ${target} matches ${selectorOnly.immId}`,
      };
    }
    return null;
  }

  private indexKey(
    chainId: number,
    target: string,
    selector: string,
    argsTemplate: `0x${string}`,
  ): string {
    const argsHash = keccak256(getBytes(argsTemplate));
    return `${chainId}:${target}:${selector}:${argsHash}`;
  }

  private tryIndex(ab: Antibody): void {
    const key = this.keyFromSeed(ab);
    if (key) this.index.set(key, ab);
  }

  private tryUnindex(ab: Antibody): void {
    const key = this.keyFromSeed(ab);
    if (key) this.index.delete(key);
  }

  private keyFromSeed(ab: Antibody): string | null {
    if (ab.abType !== "CALL_PATTERN" || !ab.seed || ab.seed.abType !== "CALL_PATTERN") {
      return null;
    }
    const expected = hashCallPatternMatcher({
      chainId: ab.seed.chainId,
      target: ab.seed.target,
      selector: ab.seed.selector,
      argsTemplate: ab.seed.argsTemplate,
    });
    if (expected !== ab.primaryMatcherHash) {
      logSeedHashMismatch(this.name, ab, expected);
      return null;
    }
    return this.indexKey(
      ab.seed.chainId,
      normalizeAddress(ab.seed.target),
      ab.seed.selector,
      ab.seed.argsTemplate,
    );
  }
}
