import { AbiCoder, keccak256 } from "ethers";
import { type AntibodyType, AntibodyTypeValue } from "../types/antibody.js";
import type { Address, Hex32 } from "../types/antibody.js";

/**
 * Mirror of `Registry._hash` / `Registry.computeKeccakId`.
 *
 * Contract definition:
 *   keccak256(abi.encode(uint8 abType, uint8 flavor, bytes32 matcher, address publisher))
 *
 * `abi.encode` (NOT `abi.encodePacked`) pads each argument to 32 bytes, so
 * the encoding tuple is `["uint8", "uint8", "bytes32", "address"]` in that order.
 *
 * Cross-validated against the deployed pure view function in the keccak unit
 * tests; any change here MUST keep that test passing.
 */
const coder = AbiCoder.defaultAbiCoder();

export function computeKeccakId(
  abType: AntibodyType,
  flavor: number,
  primaryMatcherHash: Hex32,
  publisher: Address,
): Hex32 {
  if (flavor < 0 || flavor > 255 || !Number.isInteger(flavor)) {
    throw new Error(`flavor must be uint8, got ${flavor}`);
  }
  const encoded = coder.encode(
    ["uint8", "uint8", "bytes32", "address"],
    [AntibodyTypeValue[abType], flavor, primaryMatcherHash, publisher],
  );
  return keccak256(encoded) as Hex32;
}
