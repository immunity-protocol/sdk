import type { Antibody, Hex32 } from "../types/antibody.js";

/**
 * Listener notified whenever the cache mutates. Matchers and other
 * subscribers attach handlers to keep their own derived indices in sync.
 */
export type CacheEventKind = "put" | "delete";
export type CacheListener = (kind: CacheEventKind, antibody: Antibody) => void;

/**
 * In-memory antibody store. Keyed primarily by `keccakId`; a secondary
 * `immSeq` index lets `getAntibodyByImmSeq` resolve without a full scan.
 *
 * Matchers do NOT live inside the cache; they are independent subscribers
 * that maintain their own type-specific indices via `subscribe()`.
 */
export class AntibodyCache {
  private readonly byKeccak = new Map<Hex32, Antibody>();
  private readonly byImmSeq = new Map<number, Hex32>();
  private readonly listeners = new Set<CacheListener>();

  size(): number {
    return this.byKeccak.size;
  }

  has(keccakId: Hex32): boolean {
    return this.byKeccak.has(keccakId);
  }

  get(keccakId: Hex32): Antibody | undefined {
    return this.byKeccak.get(keccakId);
  }

  getByImmSeq(immSeq: number): Antibody | undefined {
    const id = this.byImmSeq.get(immSeq);
    return id ? this.byKeccak.get(id) : undefined;
  }

  put(antibody: Antibody): void {
    this.byKeccak.set(antibody.keccakId, antibody);
    this.byImmSeq.set(antibody.immSeq, antibody.keccakId);
    this.emit("put", antibody);
  }

  delete(keccakId: Hex32): boolean {
    const existing = this.byKeccak.get(keccakId);
    if (!existing) return false;
    this.byKeccak.delete(keccakId);
    this.byImmSeq.delete(existing.immSeq);
    this.emit("delete", existing);
    return true;
  }

  values(): IterableIterator<Antibody> {
    return this.byKeccak.values();
  }

  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: CacheEventKind, antibody: Antibody): void {
    for (const l of this.listeners) {
      try {
        l(kind, antibody);
      } catch {
        // listener errors must not crash the cache
      }
    }
  }
}
