import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the matcher logger's debug output so we can assert a seed-hash
// mismatch is surfaced (not silently swallowed). Mock BEFORE importing the
// matcher so seed-hash-log binds to the mocked logger.
const debugSpy = vi.fn();
vi.mock("../../../src/util/logger.js", () => ({
  createLogger: () => ({
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: debugSpy, info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const { SemanticMatcher } = await import("../../../src/matchers/semantic.js");
const { buildAntibody, makeCache } = await import("./fixtures.js");

describe("matcher seed-hash mismatch logging (S3.3)", () => {
  beforeEach(() => debugSpy.mockClear());

  it("logs and drops a SEMANTIC antibody whose seed mismatches primaryMatcherHash", async () => {
    const ab = buildAntibody({
      abType: "SEMANTIC",
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "free money airdrop now" },
    });
    // Tamper the stored hash so recompute != primaryMatcherHash (simulates a
    // bad seed reconstruction, e.g. wrong flavor↔code mapping at bootstrap).
    const tampered = {
      ...ab,
      primaryMatcherHash:
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
    };

    const cache = makeCache([tampered]);
    const m = new SemanticMatcher();
    m.attach(cache);

    // Not indexed: the tampered marker text must not match.
    const hit = await m.match({
      tx: null,
      context: { conversation: [{ role: "user", content: "free money airdrop now please" }] },
    });
    expect(hit).toBeNull();

    // ...but the drop was logged, not swallowed.
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(String(debugSpy.mock.calls[0][0])).toMatch(/seed-hash mismatch/);
  });

  it("does not log for a correctly-hashed antibody", async () => {
    const ab = buildAntibody({
      abType: "SEMANTIC",
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "free money airdrop now" },
    });
    const cache = makeCache([ab]);
    const m = new SemanticMatcher();
    m.attach(cache);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
