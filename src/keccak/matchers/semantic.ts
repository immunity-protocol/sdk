import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import type { Hex32 } from "../../types/antibody.js";
import { type SemanticFlavor, SemanticFlavorValue } from "../../types/antibody.js";

const coder = AbiCoder.defaultAbiCoder();
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface SemanticMatcherInput {
  flavor: SemanticFlavor;
  /**
   * Identifier the matcher uses for similarity search. Either a precomputed
   * 32-byte hash (e.g. embedding-quantization fingerprint) or a canonical
   * marker string the SDK will hash for you.
   */
  pattern: { kind: "hash"; value: Hex32 } | { kind: "marker"; value: string };
}

/**
 * Canonical primary-matcher hash for SEMANTIC antibodies.
 *
 *   patternHash       = pattern.kind == 'hash'   ? pattern.value
 *                     : keccak256(utf8(pattern.value))
 *   primaryMatcherHash = keccak256(abi.encode(uint8 flavor, bytes32 patternHash))
 *
 * The `flavor` field also lives in the on-chain Antibody struct, but
 * including it in the hash means two antibodies with the same `pattern`
 * but different flavors are distinct ids (otherwise an existing
 * COUNTERPARTY antibody would block a later MANIPULATION publish on
 * the same string).
 */
export function hashSemanticMatcher(input: SemanticMatcherInput): Hex32 {
  const flavorCode = SemanticFlavorValue[input.flavor];
  const patternHash =
    input.pattern.kind === "hash"
      ? assertHex32(input.pattern.value)
      : (keccak256(toUtf8Bytes(input.pattern.value)) as Hex32);
  const encoded = coder.encode(["uint8", "bytes32"], [flavorCode, patternHash]);
  return keccak256(encoded) as Hex32;
}

function assertHex32(value: string): Hex32 {
  if (!HEX32_RE.test(value)) {
    throw new Error(`invalid bytes32 pattern hash: ${value}`);
  }
  return value as Hex32;
}
