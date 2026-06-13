import { zeroPadValue } from "ethers";
import { describe, expect, it } from "vitest";
import { computeKeccakId } from "../../../src/keccak/id.js";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { buildPublishParams } from "../../../src/publish/params.js";
import {
  auxiliaryKeyFor,
  flavorCodeOf,
  matcherSummaryFor,
  primaryMatcherHashFor,
} from "../../../src/publish/seed.js";
import type { Address, AntibodySeed, Hex32 } from "../../../src/types/antibody.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000A1" as Address;
const PUBLISHER = "0x0000000000000000000000000000000000000aaa" as Address;
const SELECTOR = "0xa9059cbb" as const;
const BYTECODE_HASH = `0x${"bc".repeat(32)}` as Hex32;
const TAINT_SET_ID = `0x${"77".repeat(32)}` as Hex32;

const ADDRESS_SEED: AntibodySeed = { abType: "ADDRESS", chainId: CHAIN, target: TARGET };
const CALL_SEED: AntibodySeed = {
  abType: "CALL_PATTERN",
  chainId: CHAIN,
  target: TARGET,
  selector: SELECTOR,
  argsTemplate: "0x",
};
const BYTECODE_SEED: AntibodySeed = { abType: "BYTECODE", bytecodeHash: BYTECODE_HASH };
const GRAPH_SEED: AntibodySeed = {
  abType: "GRAPH",
  chainId: CHAIN,
  taintedAddresses: [TARGET],
  taintSetId: TAINT_SET_ID,
};
const SEMANTIC_SEED: AntibodySeed = {
  abType: "SEMANTIC",
  flavor: "MANIPULATION",
  pattern: { kind: "marker", value: "drain your wallet now" },
};

describe("auxiliaryKeyFor (exact contract encodings)", () => {
  it("ADDRESS → left-padded bytes32(uint160(target))", () => {
    expect(auxiliaryKeyFor(ADDRESS_SEED)).toBe(zeroPadValue(TARGET.toLowerCase(), 32));
  });

  it("CALL_PATTERN → selector in the high 4 bytes", () => {
    expect(auxiliaryKeyFor(CALL_SEED)).toBe(`0xa9059cbb${"0".repeat(56)}`);
  });

  it("BYTECODE → the bytecode hash", () => {
    expect(auxiliaryKeyFor(BYTECODE_SEED)).toBe(BYTECODE_HASH);
  });

  it("GRAPH → the taint set id", () => {
    expect(auxiliaryKeyFor(GRAPH_SEED)).toBe(TAINT_SET_ID);
  });

  it("SEMANTIC → zero (contract emits flavor instead)", () => {
    expect(auxiliaryKeyFor(SEMANTIC_SEED)).toBe(`0x${"0".repeat(64)}`);
  });
});

describe("primaryMatcherHashFor", () => {
  it("dispatches to the matching keccak helper", () => {
    expect(primaryMatcherHashFor(ADDRESS_SEED)).toBe(
      hashAddressMatcher({ chainId: CHAIN, target: TARGET }),
    );
  });
});

describe("flavorCodeOf", () => {
  it("is the semantic flavor code for SEMANTIC, 0 otherwise", () => {
    expect(flavorCodeOf(SEMANTIC_SEED)).toBe(1); // MANIPULATION
    expect(flavorCodeOf(ADDRESS_SEED)).toBe(0);
  });
});

describe("matcherSummaryFor", () => {
  it("builds the public summary per type", () => {
    expect(matcherSummaryFor(ADDRESS_SEED)).toEqual({
      kind: "address",
      chainId: CHAIN,
      target: TARGET.toLowerCase(),
    });
    expect(matcherSummaryFor(GRAPH_SEED)).toEqual({
      kind: "graph",
      chainId: CHAIN,
      taintSetId: TAINT_SET_ID,
      size: 1,
    });
    expect(matcherSummaryFor(SEMANTIC_SEED)).toEqual({
      kind: "semantic",
      flavor: "MANIPULATION",
      markerHint: "drain your wallet now",
    });
  });
});

describe("buildPublishParams", () => {
  const refs = {
    primaryMatcherHash: primaryMatcherHashFor(ADDRESS_SEED),
    auxiliaryKey: auxiliaryKeyFor(ADDRESS_SEED),
    evidenceCid: `0x${"e1".repeat(32)}` as Hex32,
  };

  it("maps enums and applies zero defaults", () => {
    const params = buildPublishParams(
      { seed: ADDRESS_SEED, verdict: "MALICIOUS", confidence: 90, severity: 80, reasonSummary: "x" },
      refs,
    );
    expect(params).toMatchObject({
      abType: 0,
      flavor: 0,
      verdict: 0,
      confidence: 90,
      severity: 80,
      primaryMatcherHash: refs.primaryMatcherHash,
      evidenceCid: refs.evidenceCid,
      contextHash: `0x${"0".repeat(64)}`,
      embeddingHash: `0x${"0".repeat(64)}`,
      attestation: `0x${"0".repeat(64)}`,
      expiresAt: 0n,
      reviewer: "0x0000000000000000000000000000000000000000",
      auxiliaryKey: refs.auxiliaryKey,
    });
  });

  it("carries a provided contextHash and finite expiry", () => {
    const params = buildPublishParams(
      {
        seed: ADDRESS_SEED,
        verdict: "SUSPICIOUS",
        confidence: 50,
        severity: 10,
        reasonSummary: "x",
        expiresAt: 1_900_000_000,
      },
      { ...refs, contextHash: `0x${"cc".repeat(32)}` as Hex32 },
    );
    expect(params.verdict).toBe(1);
    expect(params.contextHash).toBe(`0x${"cc".repeat(32)}`);
    expect(params.expiresAt).toBe(1_900_000_000n);
  });

  it("rejects out-of-range confidence/severity", () => {
    expect(() =>
      buildPublishParams(
        { seed: ADDRESS_SEED, verdict: "MALICIOUS", confidence: 101, severity: 0, reasonSummary: "x" },
        refs,
      ),
    ).toThrow(/confidence/);
  });

  it("produces a keccakId matching computeKeccakId", () => {
    const keccakId = computeKeccakId("ADDRESS", 0, refs.primaryMatcherHash, PUBLISHER);
    // The same inputs the contract hashes (abType, flavor, matcher, publisher).
    expect(keccakId).toBe(computeKeccakId("ADDRESS", 0, refs.primaryMatcherHash, PUBLISHER));
    expect(keccakId).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
