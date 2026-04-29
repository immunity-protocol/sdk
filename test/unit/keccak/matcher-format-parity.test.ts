import { AbiCoder, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../../../src/keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../../../src/keccak/matchers/call-pattern.js";
import { computeTaintSetId, hashGraphMatcher } from "../../../src/keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../../../src/keccak/matchers/semantic.js";
import { SemanticFlavorValue } from "../../../src/types/antibody.js";

/**
 * Documents and locks in the on-chain format of every primary matcher hash.
 *
 * The Registry's matcherIndex uses these hashes as lookup keys; the SDK
 * publishes them and queries them via `getAntibodyByMatcherHash`. If the
 * SDK and the chain ever diverge on the encoding, every Tier-2 lookup
 * misses silently. This test runs against the same `keccak256(abi.encode(...))`
 * primitives the contract would, so a divergence here surfaces immediately.
 */
const coder = AbiCoder.defaultAbiCoder();

describe("primary matcher hash format parity", () => {
  it("ADDRESS = keccak256(abi.encode(uint256 chainId, address target))", () => {
    const chainId = 16602;
    const target = "0xa48f01287233509fd694a22bf840225062e67836";
    const expected = keccak256(
      coder.encode(["uint256", "address"], [BigInt(chainId), target]),
    );
    expect(hashAddressMatcher({ chainId, target })).toBe(expected);
  });

  it("ADDRESS lower-cases the address before encoding", () => {
    const chainId = 1;
    const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const upper = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
    expect(hashAddressMatcher({ chainId, target: lower })).toBe(
      hashAddressMatcher({ chainId, target: upper }),
    );
  });

  it("CALL_PATTERN = keccak256(abi.encode(uint256, address, bytes4, bytes32))", () => {
    const chainId = 1;
    const target = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const selector = "0xa9059cbb"; // ERC20 transfer
    const argsTemplate =
      "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";

    const argsTemplateHash = keccak256(getBytes(argsTemplate));
    const expected = keccak256(
      coder.encode(
        ["uint256", "address", "bytes4", "bytes32"],
        [BigInt(chainId), target, selector, argsTemplateHash],
      ),
    );
    expect(
      hashCallPatternMatcher({
        chainId,
        target,
        selector,
        argsTemplate,
      }),
    ).toBe(expected);
  });

  it("BYTECODE = keccak256(abi.encode(bytes32 bytecodeHash))", () => {
    const bytecodeHash =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const expected = keccak256(coder.encode(["bytes32"], [bytecodeHash]));
    expect(hashBytecodeMatcher({ bytecodeHash })).toBe(expected);
  });

  it("GRAPH = keccak256(abi.encode(bytes32 taintSetId)) where taintSetId encodes the sorted address[]", () => {
    const chainId = 11155111;
    const taintedAddresses: `0x${string}`[] = [
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000001",
    ];
    const sorted = [...taintedAddresses].sort();
    const expectedTaintSetId = keccak256(
      coder.encode(["uint256", "address[]"], [BigInt(chainId), sorted]),
    );
    const expected = keccak256(coder.encode(["bytes32"], [expectedTaintSetId]));

    expect(computeTaintSetId({ chainId, taintedAddresses })).toBe(expectedTaintSetId);
    expect(hashGraphMatcher({ chainId, taintedAddresses })).toBe(expected);
  });

  it("SEMANTIC marker = keccak256(abi.encode(uint8 flavor, bytes32 keccak256(utf8(value))))", () => {
    const marker = "social-engineering:fake-airdrop";
    const flavor = "MANIPULATION" as const;
    const patternHash = keccak256(toUtf8Bytes(marker));
    const expected = keccak256(
      coder.encode(["uint8", "bytes32"], [SemanticFlavorValue[flavor], patternHash]),
    );
    expect(
      hashSemanticMatcher({
        flavor,
        pattern: { kind: "marker", value: marker },
      }),
    ).toBe(expected);
  });

  it("SEMANTIC hash = keccak256(abi.encode(uint8 flavor, bytes32 patternHash))", () => {
    const patternHash =
      "0x1111111111111111111111111111111111111111111111111111111111111111";
    const flavor = "PROMPT_INJECTION" as const;
    const expected = keccak256(
      coder.encode(["uint8", "bytes32"], [SemanticFlavorValue[flavor], patternHash]),
    );
    expect(
      hashSemanticMatcher({
        flavor,
        pattern: { kind: "hash", value: patternHash },
      }),
    ).toBe(expected);
  });
});
