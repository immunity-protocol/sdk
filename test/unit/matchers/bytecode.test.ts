import { describe, expect, it } from "vitest";
import { BytecodeMatcher } from "../../../src/matchers/bytecode.js";
import type { Address } from "../../../src/types/antibody.js";
import { buildAntibody, bytecodeHashFor, makeCache } from "./fixtures.js";

const TARGET: Address = "0x000000000000000000000000000000000000c0de";
const CHAIN = 1;
const CODE = "0x6080604052348015" as const;

describe("BytecodeMatcher", () => {
  it("matches when fetched code hashes to a known antibody", async () => {
    const ab = buildAntibody({
      abType: "BYTECODE",
      bytecodeHash: bytecodeHashFor(CODE),
    });
    const cache = makeCache([ab]);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return CODE;
    };
    const m = new BytecodeMatcher(CHAIN, fetcher);
    m.attach(cache);

    const hit = await m.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(hit?.antibody.keccakId).toBe(ab.keccakId);
    expect(calls).toBe(1);
  });

  it("caches the fetched bytecode hash", async () => {
    const ab = buildAntibody({
      abType: "BYTECODE",
      bytecodeHash: bytecodeHashFor(CODE),
    });
    const cache = makeCache([ab]);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return CODE;
    };
    const m = new BytecodeMatcher(CHAIN, fetcher);
    m.attach(cache);

    await m.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    await m.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(calls).toBe(1);
  });

  it("short-circuits on EOA (empty code)", async () => {
    const ab = buildAntibody({
      abType: "BYTECODE",
      bytecodeHash: bytecodeHashFor(CODE),
    });
    const cache = makeCache([ab]);
    const fetcher = async () => "0x" as `0x${string}`;
    const m = new BytecodeMatcher(CHAIN, fetcher);
    m.attach(cache);

    const hit = await m.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(hit).toBeNull();
  });
});
