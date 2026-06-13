import type { Hex32 } from "../types/antibody.js";

/**
 * In-memory cache of "Registry returned no antibody for this matcher hash".
 * Lets the SDK skip a redundant RPC round-trip when the same legitimate-but-
 * uncommon counterparty hits Tier 2 repeatedly within the TTL window.
 *
 * The TTL is short by design (5 min): freshly published antibodies must
 * become visible quickly. Invalidation is otherwise eviction-driven — hydrating
 * a Tier-2 result for a matcher `evict`s its absent entry so the next probe
 * sees the live antibody. (Full event-driven invalidation from chain logs is S8.)
 */
export class NegativeMatcherCache {
  private readonly absent = new Map<Hex32, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  isCachedAsAbsent(matcherHash: Hex32): boolean {
    const expiresAt = this.absent.get(matcherHash);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.absent.delete(matcherHash);
      return false;
    }
    return true;
  }

  markAbsent(matcherHash: Hex32): void {
    this.absent.set(matcherHash, this.now() + this.ttlMs);
  }

  evict(matcherHash: Hex32): void {
    this.absent.delete(matcherHash);
  }

  size(): number {
    return this.absent.size;
  }
}
