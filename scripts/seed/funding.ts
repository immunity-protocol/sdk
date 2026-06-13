// Deployer-side funding for the seed run, using ethers directly (the SDK write
// surface deliberately does not expose mint / gas / reputation).
//
// - gas ETH: deployer → publisher wallet (publishers pay their own tx gas).
// - USDC: each publisher self-mints from MockUSDC (mint is permissionless).
// - reputation: the deployer (Reputation owner) grants genesis reputation so a
//   publisher counts toward corroboration (minCorroborationRep gate). Genesis
//   wallets already have it; throwaway validation wallets do not.
//
// TX SEQUENCING: callers pass NonceManager-wrapped signers (see seed-live.ts),
// so nonces are assigned locally and never race a lagging RPC's tx count. Even
// so, a resubmit can surface as JSON-RPC -32000 "already known" — the tx is
// already in the mempool, NOT a failure. `sendOrBenign` swallows that and the
// caller re-reads the resulting state (balance/score) to confirm the effect.

import { type Signer, formatEther, parseEther } from "ethers";
import type { NetworkConfig } from "../../src/index.js";
import { buildOnchain } from "./onchain.js";

interface SentTx {
  hash: string;
  wait(): Promise<unknown>;
}

/** True when a send failed only because the tx is already pending in the mempool. */
function isAlreadyKnown(err: unknown): boolean {
  const e = err as {
    code?: number | string;
    message?: string;
    error?: { code?: number; message?: string };
    info?: { error?: { code?: number; message?: string } };
  };
  const codes = [e?.code, e?.error?.code, e?.info?.error?.code];
  const msg =
    `${e?.message ?? ""} ${e?.error?.message ?? ""} ${e?.info?.error?.message ?? ""}`.toLowerCase();
  return (
    codes.includes(-32000) ||
    msg.includes("already known") ||
    msg.includes("already imported") ||
    msg.includes("alreadyknown")
  );
}

/**
 * Send a tx and await it, treating an "already known" rejection as benign (the
 * tx is already pending). Returns the hash only when this call sent it.
 */
async function sendOrBenign(send: () => Promise<SentTx>): Promise<{ txHash?: string }> {
  try {
    const tx = await send();
    await tx.wait();
    return { txHash: tx.hash };
  } catch (err) {
    if (!isAlreadyKnown(err)) throw err;
    return {};
  }
}

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
  const sent = await sendOrBenign(() =>
    deployer.sendTransaction({ to, value: parseEther(topUpEth) }),
  );
  return { funded: true, ...sent, balance: await provider.getBalance(to) };
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
  const sent = await sendOrBenign(() => usdc.mint(to, mintAmount));
  return { minted: true, ...sent, balance: await usdc.balanceOf(to) };
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
  const sent = await sendOrBenign(() => reputation.grantGenesisReputation(addr, target));
  return { granted: true, ...sent, score: await reputation.scoreOf(addr) };
}

/** Human-readable ETH balance, for reporting. */
export function fmtEth(wei: bigint): string {
  return formatEther(wei);
}
