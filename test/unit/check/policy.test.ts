import { describe, expect, it } from "vitest";
import { maxConfidence, planEnforcement, planFromVerdict } from "../../../src/check/policy.js";
import type { EnforcementResolution } from "../../../src/registry/enforcement.js";
import type { RawVerdict } from "../../../src/tee/parse.js";
import type { Antibody } from "../../../src/types/antibody.js";
import { buildAntibody } from "../matchers/fixtures.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000a1" as const;
const THRESHOLDS = { block: 85, escalate: 60 };

function resolution(
  tier: EnforcementResolution["tier"],
  source: EnforcementResolution["source"],
  antibodies: Antibody[] = [],
): EnforcementResolution {
  return { tier, source, antibodies, inputs: [] };
}

function ab(confidence: number): Antibody {
  return { ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }), confidence };
}

function verdict(over: Partial<RawVerdict> = {}): RawVerdict {
  return {
    verdict: "MALICIOUS",
    abType: "ADDRESS",
    flavor: null,
    confidence: 90,
    severity: 80,
    reasoning: "test",
    marker: null,
    ...over,
  };
}

describe("planEnforcement", () => {
  it("hard-block → block with max antibody confidence and the resolver source", () => {
    const intent = planEnforcement(resolution("hard-block", "registry", [ab(70), ab(95)]), {
      unverifiedAntibodyPolicy: "escalate",
      novelThreatPolicy: "verify",
    });
    expect(intent).toMatchObject({
      kind: "terminal",
      decision: "block",
      source: "registry",
      confidence: 95,
      novel: false,
    });
  });

  it("advisory + ignore → allow but not novel (fee still charged elsewhere)", () => {
    const intent = planEnforcement(resolution("advisory", "cache", [ab(80)]), {
      unverifiedAntibodyPolicy: "ignore",
      novelThreatPolicy: "verify",
    });
    expect(intent).toMatchObject({ kind: "terminal", decision: "allow", source: "cache", novel: false });
  });

  it("advisory + block → block", () => {
    const intent = planEnforcement(resolution("advisory", "cache", [ab(80)]), {
      unverifiedAntibodyPolicy: "block",
      novelThreatPolicy: "verify",
    });
    expect(intent).toMatchObject({ kind: "terminal", decision: "block", source: "cache" });
  });

  it("advisory + escalate → escalate intent", () => {
    const intent = planEnforcement(resolution("advisory", "cache", [ab(80)]), {
      unverifiedAntibodyPolicy: "escalate",
      novelThreatPolicy: "verify",
    });
    expect(intent).toMatchObject({ kind: "escalate", source: "cache", confidence: 80 });
  });

  it("advisory + corroborate → corroborate intent", () => {
    const intent = planEnforcement(resolution("advisory", "cache", [ab(80)]), {
      unverifiedAntibodyPolicy: "corroborate",
      novelThreatPolicy: "verify",
    });
    expect(intent.kind).toBe("corroborate");
  });

  it("novel + verify → verify intent", () => {
    const intent = planEnforcement(resolution("none", "none"), {
      unverifiedAntibodyPolicy: "escalate",
      novelThreatPolicy: "verify",
    });
    expect(intent.kind).toBe("verify");
  });

  it("novel + trust-cache → allow, novel=true, source=policy", () => {
    const intent = planEnforcement(resolution("none", "none"), {
      unverifiedAntibodyPolicy: "escalate",
      novelThreatPolicy: "trust-cache",
    });
    expect(intent).toMatchObject({ kind: "terminal", decision: "allow", source: "policy", novel: true });
  });

  it("novel + deny-novel → block, source=policy", () => {
    const intent = planEnforcement(resolution("none", "none"), {
      unverifiedAntibodyPolicy: "escalate",
      novelThreatPolicy: "deny-novel",
    });
    expect(intent).toMatchObject({ kind: "terminal", decision: "block", source: "policy", novel: false });
  });
});

describe("planFromVerdict", () => {
  it("MALICIOUS at/above the block threshold → block (source tee)", () => {
    const d = planFromVerdict(verdict({ confidence: 90 }), THRESHOLDS, { novel: true });
    expect(d).toMatchObject({ decision: "block", source: "tee", confidence: 90, novel: true });
  });

  it("MALICIOUS in the escalate band → escalate", () => {
    const d = planFromVerdict(verdict({ confidence: 70 }), THRESHOLDS, { novel: true });
    expect(d.decision).toBe("escalate");
  });

  it("SUSPICIOUS in the escalate band → escalate", () => {
    const d = planFromVerdict(verdict({ verdict: "SUSPICIOUS", confidence: 65 }), THRESHOLDS, { novel: true });
    expect(d.decision).toBe("escalate");
  });

  it("BENIGN → allow", () => {
    const d = planFromVerdict(verdict({ verdict: "BENIGN", confidence: 99 }), THRESHOLDS, { novel: true });
    expect(d.decision).toBe("allow");
  });

  it("low-confidence MALICIOUS (below escalate) → allow", () => {
    const d = planFromVerdict(verdict({ confidence: 40 }), THRESHOLDS, { novel: true });
    expect(d.decision).toBe("allow");
  });
});

describe("maxConfidence", () => {
  it("returns 0 for an empty set", () => {
    expect(maxConfidence([])).toBe(0);
  });
});
