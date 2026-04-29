import {
  Contract,
  type ContractRunner,
  type ContractTransactionResponse,
  type Signer,
} from "ethers";
import RegistryAbi from "../../abi/Registry.json" with { type: "json" };
import type { Address } from "../types/antibody.js";

/**
 * Proxy methods exposed on the Registry contract. Declared so downstream
 * callers get typed completion under strict + noUncheckedIndexedAccess,
 * where ethers v6's dynamic `Contract.foo` resolves to `any | undefined`.
 */
export type RegistryMethods = {
  deposit(amount: bigint): Promise<ContractTransactionResponse>;
  withdraw(amount: bigint): Promise<ContractTransactionResponse>;
  publish(params: unknown): Promise<ContractTransactionResponse>;
  check(
    antibodyId: string,
    tokenAddress: string,
    tokenAmount: bigint,
    originChainId: bigint,
  ): Promise<ContractTransactionResponse>;
  sweepExpired(): Promise<ContractTransactionResponse>;
  slash(keccakId: string): Promise<ContractTransactionResponse>;
  seedAntibody(params: unknown): Promise<ContractTransactionResponse>;
  withdrawTreasury(amount: bigint, to: string): Promise<ContractTransactionResponse>;
  balances(account: string): Promise<bigint>;
  nextImmSeq(): Promise<bigint>;
  getAntibody(keccakId: string): Promise<unknown>;
  getAntibodyByImmSeq(immSeq: number | bigint): Promise<unknown>;
  getAntibodyByMatcherHash(matcherHash: string): Promise<unknown>;
  matcherIndex(matcherHash: string): Promise<string>;
  getPublisherStats(publisher: string): Promise<unknown>;
  getActiveStakeCount(): Promise<bigint>;
  getOldestExpiredStakes(limit: number | bigint): Promise<string[]>;
  computeKeccakId(
    abType: number,
    flavor: number,
    primaryMatcherHash: string,
    publisher: string,
  ): Promise<string>;
  interface: Contract["interface"];
};

export type RegistryContract = Contract & RegistryMethods;

/**
 * Thin typed wrapper that holds the Registry `Contract` instance plus the
 * signer it's bound to. Subsequent settlement modules import helpers from
 * here rather than constructing their own Contract objects.
 */
export interface RegistryClient {
  readonly address: Address;
  readonly contract: RegistryContract;
  readonly signer: Signer;
}

export function createRegistryClient(registryAddress: Address, signer: Signer): RegistryClient {
  const contract = new Contract(
    registryAddress,
    RegistryAbi.abi,
    signer as ContractRunner,
  ) as RegistryContract;
  return { address: registryAddress, contract, signer };
}
