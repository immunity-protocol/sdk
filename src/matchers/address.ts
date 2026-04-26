import type { AntibodyCache } from "../cache/cache.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import type { Address, Antibody } from "../types/antibody.js";
import { chainAddressKey } from "../util/address.js";
import type { Matcher, MatchHit, MatchProbe } from "./matcher.js";

/**
 * AddressMatcher: O(1) lookup by `(chainId, address)` against ADDRESS-type
 * antibodies in the cache. Resolves the proposed tx's `to` and the optional
 * counterparty id (if it parses as an EVM address).
 *
 * Index is built from the canonical primary-matcher hash on cache `put`,
 * so the matcher does not need to know how the publisher composed the
 * matcher input: any antibody whose `primaryMatcherHash` equals
 * `hashAddressMatcher({chainId, target})` for a probed pair will hit.
 */
export class AddressMatcher implements Matcher {
  readonly name = "ADDRESS";
  readonly priority = 10;

  private readonly index = new Map<string, Antibody>();
  private readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  attach(cache: AntibodyCache): void {
    for (const ab of cache.values()) this.tryIndex(ab);
    cache.subscribe((kind, ab) => {
      if (kind === "put") this.tryIndex(ab);
      else this.tryUnindex(ab);
    });
  }

  async match(probe: MatchProbe): Promise<MatchHit | null> {
    const candidates = this.candidateAddresses(probe);
    for (const addr of candidates) {
      const key = chainAddressKey(this.probeChainId(probe), addr);
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

  private probeChainId(probe: MatchProbe): number {
    return probe.tx?.chainId ?? this.chainId;
  }

  private candidateAddresses(probe: MatchProbe): Address[] {
    const out: Address[] = [];
    if (probe.tx?.to) out.push(probe.tx.to);
    const cp = probe.context.counterparty?.id;
    if (cp && /^0x[0-9a-fA-F]{40}$/.test(cp)) out.push(cp as Address);
    return out;
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "ADDRESS") return;
    const reconstructed = this.tryReverseLookup(ab);
    if (reconstructed) this.index.set(reconstructed.key, ab);
  }

  private tryUnindex(ab: Antibody): void {
    if (ab.abType !== "ADDRESS") return;
    const reconstructed = this.tryReverseLookup(ab);
    if (reconstructed) this.index.delete(reconstructed.key);
  }

  /**
   * The cache stores `primaryMatcherHash` only; we need the (chainId, address)
   * pair to build the index key. Antibodies coming through the SDK's own
   * publish path attach the raw matcher data via the gossip envelope. For
   * direct-from-chain antibodies, the matcher relies on the gossip codec
   * having stashed the source pair into a side-channel (`matcherSeed` on
   * the gossip envelope).
   *
   * For now: trust that the gossip envelope decoder writes a `__addr_seed`
   * attribute onto antibodies. If absent, the matcher cannot index until
   * the SDK observes a probe with that exact `primaryMatcherHash`. This is
   * implemented in `gossip/envelope.ts` once that lands.
   */
  private tryReverseLookup(
    ab: Antibody,
  ): { key: string; chainId: number; address: Address } | null {
    const seed = (ab as Antibody & { __addrSeed?: { chainId: number; address: Address } })
      .__addrSeed;
    if (!seed) return null;
    const reconstructedHash = hashAddressMatcher({
      chainId: seed.chainId,
      target: seed.address,
    });
    if (reconstructedHash !== ab.primaryMatcherHash) return null;
    return { key: chainAddressKey(seed.chainId, seed.address), chainId: seed.chainId, address: seed.address };
  }
}
