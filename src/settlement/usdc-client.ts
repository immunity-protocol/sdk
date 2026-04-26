import { Contract, type Signer } from "ethers";
import Erc20Abi from "../../abi/ERC20.json" with { type: "json" };
import type { Address } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";

export interface UsdcClient {
  readonly address: Address;
  readonly contract: Contract;
  balanceOf(account: Address): Promise<bigint>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  approve(spender: Address, amount: bigint): Promise<string>;
  decimals(): Promise<number>;
}

export function createUsdcClient(usdcAddress: Address, signer: Signer): UsdcClient {
  const address = normalizeAddress(usdcAddress);
  const contract = new Contract(address, Erc20Abi.abi, signer);
  return {
    address,
    contract,
    async balanceOf(account: Address): Promise<bigint> {
      const v: bigint = await contract.balanceOf(normalizeAddress(account));
      return v;
    },
    async allowance(owner: Address, spender: Address): Promise<bigint> {
      const v: bigint = await contract.allowance(
        normalizeAddress(owner),
        normalizeAddress(spender),
      );
      return v;
    },
    async approve(spender: Address, amount: bigint): Promise<string> {
      const tx = await contract.approve(normalizeAddress(spender), amount);
      const receipt = await tx.wait();
      return receipt?.hash ?? tx.hash;
    },
    async decimals(): Promise<number> {
      const d: bigint | number = await contract.decimals();
      return typeof d === "bigint" ? Number(d) : d;
    },
  };
}
