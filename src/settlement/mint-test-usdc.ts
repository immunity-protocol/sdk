import type { Address, Hex32 } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import type { UsdcClient } from "./usdc-client.js";

/**
 * Testnet bootstrap helper. Calls MockUSDC's public `mint(to, amount)` to
 * fund a wallet with USDC. Permissionless on the deployed Galileo MockUSDC.
 *
 * Real USDC on mainnet has no public mint; this helper is testnet-only and
 * surfaced through `Immunity.mintTestUsdc()` as a convenience for the
 * quickstart example. Prefer the faucet for 0G; this covers USDC.
 */
export async function mintTestUsdc(usdc: UsdcClient, to: Address, amount: bigint): Promise<Hex32> {
  if (amount <= 0n) throw new Error("mint amount must be positive");
  const tx = await usdc.contract.mint(normalizeAddress(to), amount);
  const receipt = await tx.wait();
  return (receipt?.hash ?? tx.hash) as Hex32;
}
