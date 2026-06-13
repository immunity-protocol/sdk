// Deployer-side funding for the seed run, using ethers directly (the SDK write
// surface deliberately does not expose mint / gas / reputation).
//
// - gas ETH: deployer → publisher wallet (publishers pay their own tx gas).
// - USDC: each publisher self-mints from MockUSDC (mint is permissionless).
// - reputation: the deployer (Reputation owner) grants genesis reputation so a
//   publisher counts toward corroboration (minCorroborationRep gate). Genesis
//   wallets already have it; throwaway validation wallets do not.

import { type Signer, formatEther, parseEther } from "ethers";
import type { NetworkConfig } from "../../src/index.js";
import { buildOnchain } from "./onchain.js";

/** Top up a wallet's gas ETH from the deployer if it is below `minEth`. */
export async function ensureGas(
  deployer: Signer,
  to: string,
  topUpEth: string,
  minEth: string,
): Promise<{ funded: boolean; txHash?: string; balance: bigint }> {
  const provider = deployer.provider;
  if (!provider) throw new Error("deployer signer has no provider");
  const balance = await provider.getBalance(to);
  if (balance >= parseEther(minEth)) return { funded: false, balance };
  const tx = await deployer.sendTransaction({ to, value: parseEther(topUpEth) });
  await tx.wait();
  return { funded: true, txHash: tx.hash, balance: await provider.getBalance(to) };
}

/**
 * Mint USDC to `to` if its balance is below `min`. `minter` signs the mint
 * (MockUSDC.mint is permissionless): in validate the publisher self-mints
 * (minter == to), in live the deployer mints to each genesis wallet.
 */
export async function ensureUsdc(
  net: NetworkConfig,
  minter: Signer,
  to: string,
  mintAmount: bigint,
  min: bigint,
): Promise<{ minted: boolean; txHash?: string; balance: bigint }> {
  const { usdc } = buildOnchain(net, minter);
  const balance = await usdc.balanceOf(to);
  if (balance >= min) return { minted: false, balance };
  const tx = await usdc.mint(to, mintAmount);
  await tx.wait();
  return { minted: true, txHash: tx.hash, balance: await usdc.balanceOf(to) };
}

/**
 * Grant genesis reputation to `addr` via the deployer (Reputation owner) when
 * its score is below `target`. Throws if the deployer is not the owner — the
 * caller cannot otherwise make the publisher count toward corroboration.
 */
export async function ensureReputation(
  net: NetworkConfig,
  deployer: Signer,
  addr: string,
  target: bigint,
): Promise<{ granted: boolean; txHash?: string; score: bigint }> {
  const { reputation } = buildOnchain(net, deployer);
  const score = await reputation.scoreOf(addr);
  if (score >= target) return { granted: false, score };
  const owner = (await reputation.owner()).toLowerCase();
  const deployerAddr = (await deployer.getAddress()).toLowerCase();
  if (owner !== deployerAddr) {
    throw new Error(
      `cannot grant reputation to ${addr}: deployer ${deployerAddr} is not the Reputation owner (${owner})`,
    );
  }
  const tx = await reputation.grantGenesisReputation(addr, target);
  await tx.wait();
  return { granted: true, txHash: tx.hash, score: await reputation.scoreOf(addr) };
}

/** Human-readable ETH balance, for reporting. */
export function fmtEth(wei: bigint): string {
  return formatEther(wei);
}
