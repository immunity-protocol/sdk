import type { Address } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import type { RegistryClient } from "./registry-client.js";

export interface PublisherStats {
  totalStaked: bigint;
  totalEarned: bigint;
  publishedCount: bigint;
  slashedCount: bigint;
}

/**
 * Read the operator's current prepaid USDC balance held by the Registry.
 *
 * This reads the public `balances(address)` mapping (auto-generated getter
 * on Solidity public state vars), so it costs nothing.
 */
export async function balanceOf(registry: RegistryClient, account: Address): Promise<bigint> {
  const v: bigint = await registry.contract.balances(normalizeAddress(account));
  return v;
}

export async function publisherStats(
  registry: RegistryClient,
  publisher: Address,
): Promise<PublisherStats> {
  const result = (await registry.contract.getPublisherStats(normalizeAddress(publisher))) as {
    totalStaked: bigint;
    totalEarned: bigint;
    publishedCount: bigint;
    slashedCount: bigint;
  };
  return {
    totalStaked: result.totalStaked,
    totalEarned: result.totalEarned,
    publishedCount: result.publishedCount,
    slashedCount: result.slashedCount,
  };
}
