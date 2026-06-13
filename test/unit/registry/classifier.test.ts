import { describe, expect, it } from "vitest";
import { classifyEnforcement } from "../../../src/registry/enforcement.js";
import type { EnforcementInputs } from "../../../src/types/enforcement.js";
import type { Status } from "../../../src/types/antibody.js";

const K = 3;
const NOW = 1_000_000n;

function inputs(over: Partial<EnforcementInputs> = {}): EnforcementInputs {
  return {
    status: "ACTIVE",
    corroboration: 0,
    publisherRep: 0n,
    prominenceTier: 0,
    maturedAt: 0n,
    expiresAt: 0n,
    isSeeded: false,
    ...over,
  };
}

describe("classifyEnforcement", () => {
  it("hard-blocks when corroboration >= K", () => {
    expect(classifyEnforcement(inputs({ corroboration: 3 }), K, NOW)).toBe("hard-block");
    expect(classifyEnforcement(inputs({ corroboration: 5 }), K, NOW)).toBe("hard-block");
  });

  it("is advisory when corroboration is just below K", () => {
    expect(classifyEnforcement(inputs({ corroboration: 2 }), K, NOW)).toBe("advisory");
  });

  it("hard-blocks a genesis-seeded antibody regardless of corroboration", () => {
    expect(classifyEnforcement(inputs({ isSeeded: true, corroboration: 0 }), K, NOW)).toBe(
      "hard-block",
    );
  });

  it("classifies an ACTIVE-but-uncorroborated antibody as advisory (NOT hard-block)", () => {
    // The crux of the two-speed rule: ACTIVE alone (time/volume maturation)
    // must never grant censorship power.
    expect(classifyEnforcement(inputs({ status: "ACTIVE", corroboration: 0 }), K, NOW)).toBe(
      "advisory",
    );
  });

  it("handles CHALLENGED both ways", () => {
    // Corroborated/seeded → still hard-block during a challenge.
    expect(classifyEnforcement(inputs({ status: "CHALLENGED", corroboration: 3 }), K, NOW)).toBe(
      "hard-block",
    );
    expect(classifyEnforcement(inputs({ status: "CHALLENGED", isSeeded: true }), K, NOW)).toBe(
      "hard-block",
    );
    // Uncorroborated → advisory.
    expect(classifyEnforcement(inputs({ status: "CHALLENGED", corroboration: 1 }), K, NOW)).toBe(
      "advisory",
    );
  });

  it("returns none for SLASHED or EXPIRED, even if otherwise hard-block-eligible", () => {
    expect(
      classifyEnforcement(inputs({ status: "SLASHED", corroboration: 9, isSeeded: true }), K, NOW),
    ).toBe("none");
    expect(classifyEnforcement(inputs({ status: "EXPIRED", corroboration: 9 }), K, NOW)).toBe(
      "none",
    );
  });

  it("returns none past TTL (expiresAt <= nowSec), but enforces before TTL", () => {
    expect(
      classifyEnforcement(inputs({ corroboration: 5, expiresAt: NOW - 1n }), K, NOW),
    ).toBe("none");
    expect(
      classifyEnforcement(inputs({ corroboration: 5, expiresAt: NOW }), K, NOW),
    ).toBe("none");
    expect(
      classifyEnforcement(inputs({ corroboration: 5, expiresAt: NOW + 1n }), K, NOW),
    ).toBe("hard-block");
  });

  it("treats expiresAt 0 as permanent (never TTL-dead)", () => {
    expect(classifyEnforcement(inputs({ corroboration: 5, expiresAt: 0n }), K, NOW)).toBe(
      "hard-block",
    );
  });

  it("does not branch on PROBATION status — corroboration decides", () => {
    const probation: Status = "PROBATION";
    expect(classifyEnforcement(inputs({ status: probation, corroboration: 3 }), K, NOW)).toBe(
      "hard-block",
    );
    expect(classifyEnforcement(inputs({ status: probation, corroboration: 0 }), K, NOW)).toBe(
      "advisory",
    );
  });
});
