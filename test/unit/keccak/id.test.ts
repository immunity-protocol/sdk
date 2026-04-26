import { AbiCoder, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { computeKeccakId } from "../../../src/keccak/id.js";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../../../src/keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../../../src/keccak/matchers/call-pattern.js";
import { hashGraphMatcher } from "../../../src/keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../../../src/keccak/matchers/semantic.js";

const coder = AbiCoder.defaultAbiCoder();

describe("computeKeccakId", () => {
  const matcher = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
  const publisher = "0x0000000000000000000000000000000000000001" as const;

  it("matches keccak256 of abi.encode(uint8,uint8,bytes32,address)", () => {
    const expected = keccak256(
      coder.encode(["uint8", "uint8", "bytes32", "address"], [0, 0, matcher, publisher]),
    );
    expect(computeKeccakId("ADDRESS", 0, matcher, publisher)).toBe(expected);
  });

  it("changes when abType changes", () => {
    const a = computeKeccakId("ADDRESS", 0, matcher, publisher);
    const b = computeKeccakId("BYTECODE", 0, matcher, publisher);
    expect(a).not.toBe(b);
  });

  it("changes when flavor changes", () => {
    const a = computeKeccakId("SEMANTIC", 0, matcher, publisher);
    const b = computeKeccakId("SEMANTIC", 1, matcher, publisher);
    expect(a).not.toBe(b);
  });

  it("changes when publisher changes", () => {
    const a = computeKeccakId("ADDRESS", 0, matcher, publisher);
    const b = computeKeccakId(
      "ADDRESS",
      0,
      matcher,
      "0x0000000000000000000000000000000000000002",
    );
    expect(a).not.toBe(b);
  });

  it("rejects out-of-range flavor", () => {
    expect(() => computeKeccakId("ADDRESS", 256, matcher, publisher)).toThrow();
    expect(() => computeKeccakId("ADDRESS", -1, matcher, publisher)).toThrow();
  });
});

describe("primary-matcher canonicalization", () => {
  it("ADDRESS lowercases checksummed input", () => {
    const lower = hashAddressMatcher({
      chainId: 1,
      target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    const upper = hashAddressMatcher({
      chainId: 1,
      target: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
    });
    expect(lower).toBe(upper);
  });

  it("ADDRESS distinguishes chains", () => {
    const a = hashAddressMatcher({
      chainId: 1,
      target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    const b = hashAddressMatcher({
      chainId: 16602,
      target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });
    expect(a).not.toBe(b);
  });

  it("CALL_PATTERN rejects malformed selector", () => {
    expect(() =>
      hashCallPatternMatcher({
        chainId: 1,
        target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        selector: "0x123" as `0x${string}`,
      }),
    ).toThrow();
  });

  it("CALL_PATTERN treats missing argsTemplate as empty bytes", () => {
    const a = hashCallPatternMatcher({
      chainId: 1,
      target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      selector: "0xa9059cbb",
    });
    const b = hashCallPatternMatcher({
      chainId: 1,
      target: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      selector: "0xa9059cbb",
      argsTemplate: "0x",
    });
    expect(a).toBe(b);
  });

  it("BYTECODE rejects malformed hash", () => {
    expect(() =>
      hashBytecodeMatcher({ bytecodeHash: "0xdead" as `0x${string}` }),
    ).toThrow();
  });

  it("GRAPH is order-independent", () => {
    const a = hashGraphMatcher({
      chainId: 1,
      taintedAddresses: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
    });
    const b = hashGraphMatcher({
      chainId: 1,
      taintedAddresses: [
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000001",
      ],
    });
    expect(a).toBe(b);
  });

  it("GRAPH rejects empty taint set", () => {
    expect(() =>
      hashGraphMatcher({ chainId: 1, taintedAddresses: [] }),
    ).toThrow();
  });

  it("SEMANTIC marker and hash inputs reach the same id when consistent", () => {
    const marker = "social-engineering:fake-airdrop";
    const fromMarker = hashSemanticMatcher({
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: marker },
    });
    const fromHash = hashSemanticMatcher({
      flavor: "MANIPULATION",
      pattern: {
        kind: "hash",
        value: keccak256(new TextEncoder().encode(marker)) as `0x${string}`,
      },
    });
    expect(fromMarker).toBe(fromHash);
  });

  it("SEMANTIC distinguishes flavors on identical patterns", () => {
    const a = hashSemanticMatcher({
      flavor: "COUNTERPARTY",
      pattern: { kind: "marker", value: "evil.eth" },
    });
    const b = hashSemanticMatcher({
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "evil.eth" },
    });
    expect(a).not.toBe(b);
  });
});
