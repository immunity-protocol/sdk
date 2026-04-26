import { describe, expect, it } from "vitest";
import { decodeAntibody, encodeAntibody } from "../../../src/gossip/envelope.js";
import { buildAntibody } from "../matchers/fixtures.js";

describe("gossip envelope round-trip", () => {
  it("round-trips an ADDRESS antibody including its seed", () => {
    const ab = buildAntibody({
      abType: "ADDRESS",
      chainId: 16602,
      target: "0x000000000000000000000000000000000000DEAD",
    });
    ab.stakeAmount = 1_000_000n;
    ab.createdAt = 1_711_000_000n;

    const wire = encodeAntibody(ab);
    const back = decodeAntibody(wire);
    expect(back.keccakId).toBe(ab.keccakId);
    expect(back.stakeAmount).toBe(1_000_000n);
    expect(back.createdAt).toBe(1_711_000_000n);
    expect(back.seed?.abType).toBe("ADDRESS");
  });

  it("round-trips a SEMANTIC antibody with marker pattern", () => {
    const ab = buildAntibody({
      abType: "SEMANTIC",
      flavor: "PROMPT_INJECTION",
      pattern: { kind: "marker", value: "ignore previous instructions" },
    });
    const back = decodeAntibody(encodeAntibody(ab));
    expect(back.abType).toBe("SEMANTIC");
    expect(back.seed).toEqual(ab.seed);
  });

  it("rejects payloads with the wrong schema", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: "other/v1" }));
    expect(() => decodeAntibody(bytes)).toThrow();
  });
});
