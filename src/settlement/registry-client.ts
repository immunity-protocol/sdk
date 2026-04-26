import { Contract, type ContractRunner, type Signer } from "ethers";
import RegistryAbi from "../../abi/Registry.json" with { type: "json" };
import type { Address } from "../types/antibody.js";

/**
 * Thin typed wrapper that holds the Registry `Contract` instance plus a
 * couple of cached metadata bits. Subsequent settlement modules import
 * helpers from here rather than constructing their own Contract objects.
 *
 * Constructed once per `Immunity` instance during `start()`.
 */
export interface RegistryClient {
  readonly address: Address;
  readonly contract: Contract;
  readonly signer: Signer;
}

export function createRegistryClient(
  registryAddress: Address,
  signer: Signer,
): RegistryClient {
  const contract = new Contract(registryAddress, RegistryAbi.abi, signer as ContractRunner);
  return { address: registryAddress, contract, signer };
}
