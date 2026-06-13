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

  it("returns immediately with no RPC when the probe has no tx.to", async () => {
    const ab = buildAntibody({ abType: "BYTECODE", bytecodeHash: bytecodeHashFor(CODE) });
    const cache = makeCache([ab]);
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return CODE;
    };
    const m = new BytecodeMatcher(CHAIN, fetcher);
    m.attach(cache);

    const hit = await m.match({ tx: null, context: {} });
    expect(hit).toBeNull();
    expect(calls).toBe(0);
  });

  it("matches the same code on two different chains (cross-chain clone detection)", async () => {
    // One BYTECODE antibody, no chainId in its hash.
    const ab = buildAntibody({ abType: "BYTECODE", bytecodeHash: bytecodeHashFor(CODE) });
    const cache = makeCache([ab]);

    // The same runtime code is deployed at different addresses on chains 1 and 8453.
    const CHAIN_A = 1;
    const CHAIN_B = 8453;
    const ADDR_A: Address = "0x00000000000000000000000000000000000000a1";
    const ADDR_B: Address = "0x00000000000000000000000000000000000000b2";
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return CODE;
    };
    const m = new BytecodeMatcher(CHAIN_A, fetcher);
    m.attach(cache);

    const hitA = await m.match({ tx: { to: ADDR_A, chainId: CHAIN_A }, context: {} });
    const hitB = await m.match({ tx: { to: ADDR_B, chainId: CHAIN_B }, context: {} });
    expect(hitA?.antibody.keccakId).toBe(ab.keccakId);
    expect(hitB?.antibody.keccakId).toBe(ab.keccakId);
    // Distinct (chainId,address) cache keys → one fetch each, both resolve to the one antibody.
    expect(calls).toBe(2);
  });
});
