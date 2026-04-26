import type { Address, Hex32 } from "../types/antibody.js";
import { InsufficientBalanceError } from "../types/errors.js";
import { normalizeAddress } from "../util/address.js";
import type { RegistryClient } from "./registry-client.js";
import type { UsdcClient } from "./usdc-client.js";

export type ApproveMode = "exact" | "max";

const MAX_UINT = (1n << 256n) - 1n;

/**
 * Deposit USDC into the Registry's prepaid balance.
 *
 * The Registry uses `safeTransferFrom`, so the SDK must ensure allowance
 * is sufficient before calling `deposit`. We auto-approve in `exact` mode
 * by default (one extra tx, predictable) or `max` mode (one approve up
 * front, all future deposits free of the approve hop).
 */
export async function deposit(
  registry: RegistryClient,
  usdc: UsdcClient,
  account: Address,
  amount: bigint,
  approveMode: ApproveMode = "exact",
): Promise<{ depositTx: Hex32; approveTx?: Hex32 }> {
  if (amount <= 0n) throw new Error("deposit amount must be positive");

  const wallet = normalizeAddress(account);
  const balance = await usdc.balanceOf(wallet);
  if (balance < amount) throw new InsufficientBalanceError(amount, balance);

  let approveTx: Hex32 | undefined;
  const allowance = await usdc.allowance(wallet, registry.address);
  if (allowance < amount) {
    const approveAmount = approveMode === "max" ? MAX_UINT : amount;
    const txHash = await usdc.approve(registry.address, approveAmount);
    approveTx = txHash as Hex32;
  }

  const tx = await registry.contract.deposit(amount);
  const receipt = await tx.wait();
  return {
    depositTx: (receipt?.hash ?? tx.hash) as Hex32,
    ...(approveTx ? { approveTx } : {}),
  };
}

export async function withdraw(registry: RegistryClient, amount: bigint): Promise<Hex32> {
  if (amount <= 0n) throw new Error("withdraw amount must be positive");
  const tx = await registry.contract.withdraw(amount);
  const receipt = await tx.wait();
  return (receipt?.hash ?? tx.hash) as Hex32;
}
