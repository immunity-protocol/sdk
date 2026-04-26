import { Contract, type ContractTransactionResponse, type Signer } from "ethers";
import Erc20Abi from "../../abi/ERC20.json" with { type: "json" };
import type { Address } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";

export type UsdcMethods = {
  balanceOf(account: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<ContractTransactionResponse>;
  transfer(to: string, amount: bigint): Promise<ContractTransactionResponse>;
  decimals(): Promise<bigint | number>;
  mint(to: string, amount: bigint): Promise<ContractTransactionResponse>;
};

export type UsdcContract = Contract & UsdcMethods;

export interface UsdcClient {
  readonly address: Address;
  readonly contract: UsdcContract;
  balanceOf(account: Address): Promise<bigint>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  approve(spender: Address, amount: bigint): Promise<string>;
  decimals(): Promise<number>;
}

export function createUsdcClient(usdcAddress: Address, signer: Signer): UsdcClient {
  const address = normalizeAddress(usdcAddress);
  const contract = new Contract(address, Erc20Abi.abi, signer) as UsdcContract;
  return {
    address,
    contract,
    async balanceOf(account: Address): Promise<bigint> {
      return contract.balanceOf(normalizeAddress(account));
    },
    async allowance(owner: Address, spender: Address): Promise<bigint> {
      return contract.allowance(normalizeAddress(owner), normalizeAddress(spender));
    },
    async approve(spender: Address, amount: bigint): Promise<string> {
      const tx = await contract.approve(normalizeAddress(spender), amount);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
    async decimals(): Promise<number> {
      const d = await contract.decimals();
      return typeof d === "bigint" ? Number(d) : d;
    },
  };
}
