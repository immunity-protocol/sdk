import { AbiCoder, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../../../src/keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../../../src/keccak/matchers/call-pattern.js";
import { hashGraphMatcher } from "../../../src/keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../../../src/keccak/matchers/semantic.js";
import {
  type Address,
  type AntibodySeed,
  type Hex32,
  type SemanticFlavor,
  SemanticFlavorValue,
} from "../../../src/types/antibody.js";

/**
 * Proves the seed → primaryMatcherHash round-trip the S8 bootstrap relies on:
 * a seed reconstructed from observable facts re-hashes to the SAME
 * primaryMatcherHash, so a SEMANTIC antibody (or any other) is never silently
 * dropped by the matcher's `expected !== primaryMatcherHash` guard.
 *
 * The load-bearing case is the SemanticFlavor string↔uint8 mapping: a wrong
 * map at reconstruction produces a non-matching hash, so every flavor is
 * exercised here.
 */
const coder = AbiCoder.defaultAbiCoder();

// Independent reference hash for a SEMANTIC marker seed (mirrors the contract
// formula, does not call the production hasher).
function refSemanticMarkerHash(flavorCode: number, marker: string): Hex32 {
  const patternHash = keccak256(toUtf8Bytes(marker));
  return keccak256(coder.encode(["uint8", "bytes32"], [flavorCode, patternHash])) as Hex32;
}

describe("SemanticFlavor seed↔hash round-trip", () => {
  it("locks the flavor string↔uint8 mapping", () => {
    expect(SemanticFlavorValue).toEqual({
      COUNTERPARTY: 0,
      MANIPULATION: 1,
      PROMPT_INJECTION: 2,
    });
  });

  it.each(Object.keys(SemanticFlavorValue) as SemanticFlavor[])(
    "round-trips flavor %s through hashSemanticMatcher",
    (flavor) => {
      const marker = `marker-for-${flavor}-attack-vector`;
      const seed: AntibodySeed = {
        abType: "SEMANTIC",
        flavor,
        pattern: { kind: "marker", value: marker },
      };
      const produced = hashSemanticMatcher({ flavor: seed.flavor, pattern: seed.pattern });
      const reference = refSemanticMarkerHash(SemanticFlavorValue[flavor], marker);
      expect(produced).toBe(reference);

      // seed -> public summary (flavor string + markerHint) -> reconstructed
      // seed -> same hash (the bootstrap path for SEMANTIC).
      const summary = { kind: "semantic" as const, flavor, markerHint: marker };
      const reconstructed: AntibodySeed = {
        abType: "SEMANTIC",
        flavor: summary.flavor as SemanticFlavor,
        pattern: { kind: "marker", value: summary.markerHint },
      };
      expect(
        hashSemanticMatcher({ flavor: reconstructed.flavor, pattern: reconstructed.pattern }),
      ).toBe(produced);
    },
  );

  it("distinct flavors on the same marker produce distinct hashes", () => {
    const marker = "approve unlimited spend on a fresh contract";
    const hashes = (Object.keys(SemanticFlavorValue) as SemanticFlavor[]).map((flavor) =>
      hashSemanticMatcher({ flavor, pattern: { kind: "marker", value: marker } }),
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("non-semantic seed↔hash round-trip", () => {
  it("ADDRESS round-trips through its public summary", () => {
    const chainId = 84532;
    const target: Address = "0x000000000000000000000000000000000000dead";
    const seed: AntibodySeed = { abType: "ADDRESS", chainId, target };
    const produced = hashAddressMatcher({ chainId: seed.chainId, target: seed.target });
    const reference = keccak256(
      coder.encode(["uint256", "address"], [BigInt(chainId), target]),
    ) as Hex32;
    expect(produced).toBe(reference);

    // summary {kind, chainId, target} -> reconstructed seed -> same hash.
    const summary = { kind: "address" as const, chainId, target };
    expect(hashAddressMatcher({ chainId: summary.chainId, target: summary.target })).toBe(produced);
  });

  it("BYTECODE round-trips through its public summary", () => {
    const bytecodeHash =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex32;
    const produced = hashBytecodeMatcher({ bytecodeHash });
    const reference = keccak256(coder.encode(["bytes32"], [bytecodeHash])) as Hex32;
    expect(produced).toBe(reference);
    const summary = { kind: "bytecode" as const, bytecodeHash };
    expect(hashBytecodeMatcher({ bytecodeHash: summary.bytecodeHash })).toBe(produced);
  });

  it("CALL_PATTERN recompute matches (full seed — summary omits argsTemplate)", () => {
    const seed: AntibodySeed = {
      abType: "CALL_PATTERN",
      chainId: 84532,
      target: "0x000000000000000000000000000000000000beef",
      selector: "0xa9059cbb",
      argsTemplate: "0x0000000000000000000000000000000000000000000000000000000000000001",
    };
    const produced = hashCallPatternMatcher({
      chainId: seed.chainId,
      target: seed.target,
      selector: seed.selector,
      argsTemplate: seed.argsTemplate,
    });
    const reference = keccak256(
      coder.encode(
        ["uint256", "address", "bytes4", "bytes32"],
        [
          BigInt(seed.chainId),
          seed.target,
          seed.selector,
          keccak256(getBytes(seed.argsTemplate)),
        ],
      ),
    ) as Hex32;
    expect(produced).toBe(reference);
  });

  it("GRAPH recompute matches (full seed — summary omits the address set)", () => {
    const seed: AntibodySeed = {
      abType: "GRAPH",
      chainId: 84532,
      taintedAddresses: [
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000001",
      ],
      taintSetId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    const produced = hashGraphMatcher({
      chainId: seed.chainId,
      taintedAddresses: seed.taintedAddresses,
    });
    const sorted = [...seed.taintedAddresses].sort();
    const taintSetId = keccak256(
      coder.encode(["uint256", "address[]"], [BigInt(seed.chainId), sorted]),
    );
    const reference = keccak256(coder.encode(["bytes32"], [taintSetId])) as Hex32;
    expect(produced).toBe(reference);
  });
});
