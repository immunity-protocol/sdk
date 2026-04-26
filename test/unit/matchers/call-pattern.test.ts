import { describe, expect, it } from "vitest";
import { CallPatternMatcher } from "../../../src/matchers/call-pattern.js";
import { buildAntibody, makeCache } from "./fixtures.js";

const TARGET = "0x000000000000000000000000000000000000beef" as const;
const TRANSFER = "0xa9059cbb" as const;
const CHAIN = 1;
const ARGS_64 = "f".repeat(128) as string;

describe("CallPatternMatcher", () => {
  it("matches selector + exact args", async () => {
    const ab = buildAntibody({
      abType: "CALL_PATTERN",
      chainId: CHAIN,
      target: TARGET,
      selector: TRANSFER,
      argsTemplate: `0x${ARGS_64}` as `0x${string}`,
    });
    const cache = makeCache([ab]);
    const m = new CallPatternMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: {
        to: TARGET,
        chainId: CHAIN,
        data: `${TRANSFER}${ARGS_64}` as `0x${string}`,
      },
      context: {},
    });
    expect(hit?.antibody.keccakId).toBe(ab.keccakId);
  });

  it("falls back to selector-only match", async () => {
    const ab = buildAntibody({
      abType: "CALL_PATTERN",
      chainId: CHAIN,
      target: TARGET,
      selector: TRANSFER,
      argsTemplate: "0x",
    });
    const cache = makeCache([ab]);
    const m = new CallPatternMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: {
        to: TARGET,
        chainId: CHAIN,
        data: `${TRANSFER}${ARGS_64}` as `0x${string}`,
      },
      context: {},
    });
    expect(hit?.antibody.keccakId).toBe(ab.keccakId);
  });

  it("misses when selector differs", async () => {
    const ab = buildAntibody({
      abType: "CALL_PATTERN",
      chainId: CHAIN,
      target: TARGET,
      selector: TRANSFER,
      argsTemplate: "0x",
    });
    const cache = makeCache([ab]);
    const m = new CallPatternMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: TARGET, chainId: CHAIN, data: "0xdeadbeef" as `0x${string}` },
      context: {},
    });
    expect(hit).toBeNull();
  });

  it("misses when target differs", async () => {
    const ab = buildAntibody({
      abType: "CALL_PATTERN",
      chainId: CHAIN,
      target: TARGET,
      selector: TRANSFER,
      argsTemplate: "0x",
    });
    const cache = makeCache([ab]);
    const m = new CallPatternMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: {
        to: "0x0000000000000000000000000000000000000001",
        chainId: CHAIN,
        data: TRANSFER,
      },
      context: {},
    });
    expect(hit).toBeNull();
  });

  it("returns null on bare action with no calldata", async () => {
    const ab = buildAntibody({
      abType: "CALL_PATTERN",
      chainId: CHAIN,
      target: TARGET,
      selector: TRANSFER,
      argsTemplate: "0x",
    });
    const cache = makeCache([ab]);
    const m = new CallPatternMatcher(CHAIN);
    m.attach(cache);

    expect(await m.match({ tx: null, context: {} })).toBeNull();
    expect(await m.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} })).toBeNull();
  });
});
