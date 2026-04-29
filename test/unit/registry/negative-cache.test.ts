import { describe, expect, it } from "vitest";
import { NegativeMatcherCache } from "../../../src/registry/negative-cache.js";
import type { Hex32 } from "../../../src/types/antibody.js";

const HASH_A: Hex32 = `0x${"a".repeat(64)}` as Hex32;
const HASH_B: Hex32 = `0x${"b".repeat(64)}` as Hex32;

function fakeClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("NegativeMatcherCache", () => {
  it("returns false for entries that were never marked", () => {
    const cache = new NegativeMatcherCache();
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(false);
  });

  it("returns true for entries marked within the TTL", () => {
    const clock = fakeClock(0);
    const cache = new NegativeMatcherCache({ ttlMs: 1000, now: clock.now });
    cache.markAbsent(HASH_A);
    clock.advance(500);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(true);
  });

  it("expires entries past the TTL boundary and clears them lazily", () => {
    const clock = fakeClock(0);
    const cache = new NegativeMatcherCache({ ttlMs: 1000, now: clock.now });
    cache.markAbsent(HASH_A);
    clock.advance(1000);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("evict() removes the entry immediately so the next lookup misses", () => {
    const cache = new NegativeMatcherCache();
    cache.markAbsent(HASH_A);
    cache.markAbsent(HASH_B);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(true);
    cache.evict(HASH_A);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(false);
    expect(cache.isCachedAsAbsent(HASH_B)).toBe(true);
  });

  it("evicting an unknown hash is a no-op", () => {
    const cache = new NegativeMatcherCache();
    expect(() => cache.evict(HASH_A)).not.toThrow();
  });

  it("defaults to a 5-minute TTL", () => {
    const clock = fakeClock(0);
    const cache = new NegativeMatcherCache({ now: clock.now });
    cache.markAbsent(HASH_A);
    clock.advance(5 * 60 * 1000 - 1);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(true);
    clock.advance(1);
    expect(cache.isCachedAsAbsent(HASH_A)).toBe(false);
  });
});
