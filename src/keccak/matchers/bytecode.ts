import { AbiCoder, keccak256 } from "ethers";
import type { Hex32 } from "../../types/antibody.js";

const coder = AbiCoder.defaultAbiCoder();
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface BytecodeMatcherInput {
  /**
   * keccak256 of the runtime bytecode of the contract being identified
   * (i.e. `EXTCODEHASH` of the deployed contract). Lowercase, 0x-prefixed.
   */
  bytecodeHash: Hex32;
}

/**
 * Canonical primary-matcher hash for BYTECODE antibodies.
 *
 *   keccak256(abi.encode(bytes32 bytecodeHash))
 *
 * The wrap is intentional: it keeps the protocol uniform across types,
 * so `primaryMatcherHash` is never coincidentally equal to a raw
 * EXTCODEHASH another consumer might also be tracking.
 */
export function hashBytecodeMatcher(input: BytecodeMatcherInput): Hex32 {
  if (!HEX32_RE.test(input.bytecodeHash)) {
    throw new Error(`invalid bytecodeHash: ${input.bytecodeHash} (expected 0x + 64 hex)`);
  }
  const encoded = coder.encode(["bytes32"], [input.bytecodeHash]);
  return keccak256(encoded) as Hex32;
}
