import { AbiCoder, getBytes, keccak256 } from "ethers";
import type { Address, Hex32 } from "../../types/antibody.js";
import { normalizeAddress } from "../../util/address.js";

const coder = AbiCoder.defaultAbiCoder();
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

export interface CallPatternMatcherInput {
  chainId: number;
  target: Address;
  selector: `0x${string}`;
  /**
   * Canonical argument template the matcher checks against, encoded as
   * raw calldata after the 4-byte selector. May be empty (`0x`) for
   * selector-only patterns.
   */
  argsTemplate?: `0x${string}`;
}

/**
 * Canonical primary-matcher hash for CALL_PATTERN antibodies.
 *
 *   keccak256(abi.encode(
 *       uint256 chainId,
 *       address target,
 *       bytes4  selector,
 *       bytes32 argsTemplateHash
 *   ))
 *
 * `argsTemplateHash = keccak256(argsTemplate)` so the on-chain hash stays
 * a constant 32-byte size regardless of arg-template length.
 */
export function hashCallPatternMatcher(input: CallPatternMatcherInput): Hex32 {
  if (!SELECTOR_RE.test(input.selector)) {
    throw new Error(`invalid selector: ${input.selector} (expected 0x + 8 hex)`);
  }
  const argsTemplate = input.argsTemplate ?? "0x";
  const argsTemplateHash = keccak256(getBytes(argsTemplate));
  const encoded = coder.encode(
    ["uint256", "address", "bytes4", "bytes32"],
    [BigInt(input.chainId), normalizeAddress(input.target), input.selector, argsTemplateHash],
  );
  return keccak256(encoded) as Hex32;
}
