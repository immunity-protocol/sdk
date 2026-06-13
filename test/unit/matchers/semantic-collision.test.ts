import { describe, expect, it } from "vitest";
import { SemanticMatcher } from "../../../src/matchers/semantic.js";
import type { Address } from "../../../src/types/antibody.js";
import { buildAntibody, makeCache } from "./fixtures.js";

const PUB_A: Address = "0x00000000000000000000000000000000000000a1";
const PUB_B: Address = "0x00000000000000000000000000000000000000b2";

const MARKER = "limited-time bonus offer expires";
const probe = {
  tx: null,
  context: { conversation: [{ role: "user" as const, content: `Hurry: ${MARKER}!` }] },
};

describe("SemanticMatcher marker-index collision", () => {
  it("indexes two antibodies sharing one marker; unindexing one keeps the other", async () => {
    const a = buildAntibody(
      { abType: "SEMANTIC", flavor: "MANIPULATION", pattern: { kind: "marker", value: MARKER } },
      PUB_A,
    );
    const b = buildAntibody(
      { abType: "SEMANTIC", flavor: "MANIPULATION", pattern: { kind: "marker", value: MARKER } },
      PUB_B,
    );
    expect(a.keccakId).not.toBe(b.keccakId);

    const cache = makeCache([a, b]);
    const m = new SemanticMatcher();
    m.attach(cache);

    // Both present: deterministic winner is the lowest-immSeq (a, built first).
    expect((await m.match(probe))?.antibody.keccakId).toBe(a.keccakId);

    // Unindex a -> the shared marker entry must survive and still match b.
    cache.delete(a.keccakId);
    expect((await m.match(probe))?.antibody.keccakId).toBe(b.keccakId);

    // Unindex b -> no antibodies left for the marker.
    cache.delete(b.keccakId);
    expect(await m.match(probe)).toBeNull();
  });

  it("returns the same deterministic winner regardless of insertion order", async () => {
    const first = buildAntibody(
      { abType: "SEMANTIC", flavor: "MANIPULATION", pattern: { kind: "marker", value: MARKER } },
      PUB_A,
    );
    const second = buildAntibody(
      { abType: "SEMANTIC", flavor: "MANIPULATION", pattern: { kind: "marker", value: MARKER } },
      PUB_B,
    );
    // Insert in reverse order; winner stays the lowest-immSeq antibody.
    const cache = makeCache([second, first]);
    const m = new SemanticMatcher();
    m.attach(cache);
    expect((await m.match(probe))?.antibody.keccakId).toBe(first.keccakId);
  });
});
