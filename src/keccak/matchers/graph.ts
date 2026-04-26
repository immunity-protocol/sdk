import { AbiCoder, keccak256 } from "ethers";
import type { Address, Hex32 } from "../../types/antibody.js";
import { normalizeAddress } from "../../util/address.js";

const coder = AbiCoder.defaultAbiCoder();

export interface GraphMatcherInput {
  chainId: number;
  /**
   * Set of addresses considered tainted. Order does not affect the hash:
   * the SDK sorts ascending lowercase before hashing so equivalent sets
   * produce equivalent ids.
   */
  taintedAddresses: Address[];
}

/**
 * Canonical primary-matcher hash for GRAPH antibodies.
 *
 *   taintSetId        = keccak256(abi.encode(uint256 chainId, address[] sorted))
 *   primaryMatcherHash = keccak256(abi.encode(bytes32 taintSetId))
 *
 * The double-hash allows the on-chain `GraphTaintAdded` event to index by
 * `taintSetId` (which the indexer can group by) while keeping the antibody
 * id wrapped uniformly with the other types.
 */
export function hashGraphMatcher(input: GraphMatcherInput): Hex32 {
  if (input.taintedAddresses.length === 0) {
    throw new Error("graph matcher needs at least one tainted address");
  }
  const sorted = [...input.taintedAddresses]
    .map(normalizeAddress)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const taintSetId = keccak256(
    coder.encode(["uint256", "address[]"], [BigInt(input.chainId), sorted]),
  );
  return keccak256(coder.encode(["bytes32"], [taintSetId])) as Hex32;
}

/**
 * Recompute just the `taintSetId` (used by the auxiliary `GraphTaintAdded`
 * event indexer). Equivalent to the inner `keccak256` of `hashGraphMatcher`.
 */
export function computeTaintSetId(input: GraphMatcherInput): Hex32 {
  const sorted = [...input.taintedAddresses]
    .map(normalizeAddress)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keccak256(
    coder.encode(["uint256", "address[]"], [BigInt(input.chainId), sorted]),
  ) as Hex32;
}
