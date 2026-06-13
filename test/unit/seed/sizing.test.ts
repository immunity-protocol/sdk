import { describe, expect, it } from "vitest";
import { depositTarget, mintTarget, sumBonds, withBuffer } from "../../../scripts/seed/sizing.js";

describe("seed sizing", () => {
  it("sums per-target bonds", () => {
    expect(sumBonds([1_000_000n, 2_000_000n, 500_000n])).toBe(3_500_000n);
    expect(sumBonds([])).toBe(0n);
  });

  it("adds a percentage buffer with integer floor", () => {
    expect(withBuffer(1_000_000n, 50n)).toBe(1_500_000n);
    expect(withBuffer(3n, 50n)).toBe(4n); // 3 + floor(1.5)
    expect(withBuffer(1_000_000n, 0n)).toBe(1_000_000n);
  });

  it("sizes the deposit as bonds + 50% buffer", () => {
    expect(depositTarget([2_000_000n, 2_000_000n])).toBe(6_000_000n);
  });

  it("sizes the mint as registrationBond + deposit + 20% buffer", () => {
    // (10 + 6) USDC * 1.2 = 19.2 USDC
    expect(mintTarget(10_000_000n, 6_000_000n)).toBe(19_200_000n);
  });
});
