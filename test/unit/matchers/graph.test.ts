import { describe, expect, it } from "vitest";
import { GraphMatcher } from "../../../src/matchers/graph.js";
import { buildAntibody, makeCache } from "./fixtures.js";

const ALICE = "0x000000000000000000000000000000000000a11c" as const;
const BOB = "0x0000000000000000000000000000000000000b0b" as const;
const CHAIN = 1;

describe("GraphMatcher", () => {
  it("hits when probe address is in the taint set", async () => {
    const ab = buildAntibody({
      abType: "GRAPH",
      chainId: CHAIN,
      taintedAddresses: [ALICE, BOB],
      taintSetId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    const cache = makeCache([ab]);
    const m = new GraphMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({ tx: { to: BOB, chainId: CHAIN }, context: {} });
    expect(hit?.antibody.keccakId).toBe(ab.keccakId);
  });

  it("misses when probe address is not in the taint set", async () => {
    const ab = buildAntibody({
      abType: "GRAPH",
      chainId: CHAIN,
      taintedAddresses: [ALICE],
      taintSetId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    });
    const cache = makeCache([ab]);
    const m = new GraphMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: "0x0000000000000000000000000000000000000099", chainId: CHAIN },
      context: {},
    });
    expect(hit).toBeNull();
  });
});
