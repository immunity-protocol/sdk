import type { AntibodyCache } from "../cache/cache.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import type { Address, Antibody } from "../types/antibody.js";
import { chainAddressKey } from "../util/address.js";
import type { Matcher, MatchHit, MatchProbe } from "./matcher.js";

/**
 * AddressMatcher: O(1) lookup by `(chainId, address)` against ADDRESS-type
 * antibodies in the cache. Probes the proposed tx's `to` and the optional
 * counterparty id when it parses as an EVM address.
 *
 * The index key comes from `Antibody.seed` (carried on gossip envelopes).
 * Antibodies hydrated bare from chain reads have no seed and therefore
 * cannot be indexed; they only match if a future gossip arrival fills in
 * the seed for the same `keccakId`. We verify the seed by recomputing the
 * primary-matcher hash and rejecting any mismatch.
 */
export class AddressMatcher implements Matcher {
  readonly name = "ADDRESS";
  readonly priority = 10;

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
    const chainId = probe.tx?.chainId ?? this.defaultChainId;
    for (const addr of this.candidateAddresses(probe)) {
      const key = chainAddressKey(chainId, addr);
      const ab = this.index.get(key);
      if (ab && ab.status === "ACTIVE") {
        return {
          antibody: ab,
          matcherName: this.name,
          reason: `address ${addr} matches ${ab.immId}`,
        };
      }
    }
    return null;
  }

  private candidateAddresses(probe: MatchProbe): Address[] {
    const out: Address[] = [];
    if (probe.tx?.to) out.push(probe.tx.to);
    const cp = probe.context.counterparty?.id;
    if (cp && /^0x[0-9a-fA-F]{40}$/.test(cp)) out.push(cp as Address);
    return out;
  }

  private tryIndex(ab: Antibody): void {
    const key = this.indexKey(ab);
    if (key) this.index.set(key, ab);
  }

  private tryUnindex(ab: Antibody): void {
    const key = this.indexKey(ab);
    if (key) this.index.delete(key);
  }

  private indexKey(ab: Antibody): string | null {
    if (ab.abType !== "ADDRESS" || !ab.seed || ab.seed.abType !== "ADDRESS") return null;
    const expected = hashAddressMatcher({ chainId: ab.seed.chainId, target: ab.seed.target });
    if (expected !== ab.primaryMatcherHash) return null;
    return chainAddressKey(ab.seed.chainId, ab.seed.target);
  }
}
