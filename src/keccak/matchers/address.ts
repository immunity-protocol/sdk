import { AbiCoder, keccak256 } from "ethers";
import type { Address, Hex32 } from "../../types/antibody.js";
import { normalizeAddress } from "../../util/address.js";

const coder = AbiCoder.defaultAbiCoder();

export interface AddressMatcherInput {
  chainId: number;
  target: Address;
}

/**
 * Canonical primary-matcher hash for ADDRESS antibodies.
 *
 *   keccak256(abi.encode(uint256 chainId, address target))
 *
 * The address is lowercase-normalized before encoding so `0xAbC…` and
 * `0xabc…` produce the same id, which is critical for cache lookups.
 */
export function hashAddressMatcher(input: AddressMatcherInput): Hex32 {
  const target = normalizeAddress(input.target);
  const encoded = coder.encode(["uint256", "address"], [BigInt(input.chainId), target]);
  return keccak256(encoded) as Hex32;
}
