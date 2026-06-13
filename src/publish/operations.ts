import type { Address } from "../types/antibody.js";
import type { NetworkConfig } from "../types/config.js";
import { AlreadyRegisteredError } from "../types/errors.js";
import { mapRevert } from "./revert.js";

/** Minimal shape of an ethers state-changing tx response. */
export interface ContractTx {
  hash: string;
  wait(): Promise<unknown>;
}

/** The USDC methods the write surface needs (approve/allowance). */
export interface Erc20Like {
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<ContractTx>;
}

/** The `PublisherRegistrar` methods the write surface needs. */
export interface RegistrarLike {
  registrationBond(): Promise<bigint>;
  isRegistered(account: string): Promise<boolean>;
  registerPublisher(label: string): Promise<ContractTx>;
  deregister(): Promise<ContractTx>;
}

/**
 * The injected dependency bag for the write surface. Each contract is a minimal
 * STRUCTURAL interface so a real ethers `Contract` satisfies it via a cast and
 * tests inject `vi.fn` mocks — mirroring S5's `SettlementRegistry`.
 */
export interface WriteDeps {
  publisher: Address;
  network: NetworkConfig;
  registrar: RegistrarLike;
  usdc: Erc20Like;
}

/**
 * Approve `spender` for at least `amount` of USDC — but only when the existing
 * allowance is short (saves a redundant approval tx). No-op for a zero amount.
 */
export async function ensureAllowance(
  usdc: Erc20Like,
  owner: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) return;
  const current = await usdc.allowance(owner, spender);
  if (current >= amount) return;
  await (await usdc.approve(spender, amount)).wait();
}

/**
 * Register the publisher's ENS identity: approve the registration bond to the
 * registrar (if needed) and call `registerPublisher(label)`. The registrar
 * pulls the bond via `transferFrom`, so the registrar is the approval spender.
 */
export async function registerPublisher(
  deps: WriteDeps,
  label: string,
): Promise<{ txHash: string; bond: bigint }> {
  if (await deps.registrar.isRegistered(deps.publisher)) throw new AlreadyRegisteredError();
  const bond = await deps.registrar.registrationBond();
  await ensureAllowance(deps.usdc, deps.publisher, deps.network.addresses.registrar, bond);
  try {
    const tx = await deps.registrar.registerPublisher(label);
    await tx.wait();
    return { txHash: tx.hash, bond };
  } catch (err) {
    mapRevert(err);
  }
}

/** Release the registration: refunds the bond and frees the identity. */
export async function deregister(deps: WriteDeps): Promise<{ txHash: string }> {
  const tx = await deps.registrar.deregister();
  await tx.wait();
  return { txHash: tx.hash };
}

/** Whether the publisher is a registered publisher (read-only). */
export async function isRegistered(deps: WriteDeps): Promise<boolean> {
  return deps.registrar.isRegistered(deps.publisher);
}
