import type { AntibodyCache } from "../cache/cache.js";
import { hashGraphMatcher } from "../keccak/matchers/graph.js";
import type { Address, Antibody, Hex32 } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import type { MatchHit, MatchProbe, Matcher } from "./matcher.js";

/**
 * GraphMatcher: O(probe candidates) membership check across all GRAPH-type
 * antibodies. Each tainted address points back to every GRAPH antibody it
 * appears in, so a probe address yields candidate antibodies in O(1).
 *
 * v1 considers a graph antibody a "hit" when ANY probed address (tx.to or
 * counterparty.id) appears in its taint set. v2 will add transitive-taint
 * graph traversal; that lives outside the SDK's hot path.
 */
export class GraphMatcher implements Matcher {
  readonly name = "GRAPH";
  readonly priority = 30;

  /** chainId+address -> set of antibody keccakIds whose taint set contains it */
  private readonly tainted = new Map<string, Set<Hex32>>();
  private readonly antibodies = new Map<Hex32, Antibody>();
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
      const key = this.taintKey(chainId, addr);
      const ids = this.tainted.get(key);
      if (!ids) continue;
      for (const id of ids) {
        const ab = this.antibodies.get(id);
        if (ab && ab.status === "ACTIVE") {
          return {
            antibody: ab,
            matcherName: this.name,
            reason: `address ${addr} is tainted by ${ab.immId}`,
          };
        }
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

  private taintKey(chainId: number, addr: string): string {
    return `${chainId}:${normalizeAddress(addr)}`;
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "GRAPH" || !ab.seed || ab.seed.abType !== "GRAPH") return;
    const expected = hashGraphMatcher({
      chainId: ab.seed.chainId,
      taintedAddresses: ab.seed.taintedAddresses,
    });
    if (expected !== ab.primaryMatcherHash) return;

    this.antibodies.set(ab.keccakId, ab);
    for (const a of ab.seed.taintedAddresses) {
      const key = this.taintKey(ab.seed.chainId, a);
      const ids = this.tainted.get(key) ?? new Set();
      ids.add(ab.keccakId);
      this.tainted.set(key, ids);
    }
  }

  private tryUnindex(ab: Antibody): void {
    if (ab.abType !== "GRAPH" || !ab.seed || ab.seed.abType !== "GRAPH") return;
    this.antibodies.delete(ab.keccakId);
    for (const a of ab.seed.taintedAddresses) {
      const key = this.taintKey(ab.seed.chainId, a);
      const ids = this.tainted.get(key);
      if (!ids) continue;
      ids.delete(ab.keccakId);
      if (ids.size === 0) this.tainted.delete(key);
    }
  }
}
