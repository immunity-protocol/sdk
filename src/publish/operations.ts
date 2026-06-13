import { computeKeccakId } from "../keccak/id.js";
import type { PutEvidenceResult } from "../storage/client.js";
import { encryptContext } from "../storage/crypto.js";
import type { EciesBundle } from "../storage/crypto.js";
import type { PublicEnvelopeV1 } from "../storage/envelope.js";
import { type Address, type Hex32, formatImmId } from "../types/antibody.js";
import type { NetworkConfig } from "../types/config.js";
import { AlreadyRegisteredError } from "../types/errors.js";
import {
  type PublishInput,
  type PublishParams,
  type PublishResult,
  buildPublishParams,
} from "./params.js";
import { mapRevert } from "./revert.js";
import { auxiliaryKeyFor, flavorCodeOf, matcherSummaryFor, primaryMatcherHashFor } from "./seed.js";

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

/** The `ImmunityRegistry` write/read methods the write surface needs. */
export interface RegistryLike {
  deposit(amount: bigint): Promise<ContractTx>;
  withdraw(amount: bigint): Promise<ContractTx>;
  /** The operator's internal deposited balance (the public `balances` mapping). */
  balances(account: string): Promise<bigint>;
  publish(params: PublishParams): Promise<ContractTx>;
  mature(antibodyId: string): Promise<ContractTx>;
  /** Quote the publish bond for a (severity, target) — used to gate auto-publish. */
  computeBond(severity: number, target: string): Promise<bigint>;
  /** Reads back the stored antibody — for the assigned `immSeq` + the bond (challenge sizing). */
  getAntibody(keccakId: string): Promise<{ immSeq: bigint | number; bondAmount: bigint | number }>;
}

/** The `ChallengeManager` methods the write surface needs. */
export interface ChallengeManagerLike {
  challengeBondBps(): Promise<bigint | number>;
  minChallengeBond(): Promise<bigint>;
  challenge(antibodyId: string): Promise<ContractTx>;
}

/** The evidence-transport methods the publish pipeline needs (a `StorageClient`). */
export interface StoragePort {
  putEvidence(
    envelope: PublicEnvelopeV1,
    encryptedContext?: EciesBundle,
  ): Promise<PutEvidenceResult>;
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
  registry: RegistryLike;
  challengeManager: ChallengeManagerLike;
  storage: StoragePort;
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

/**
 * Fund the operator balance: approve USDC to the registry (if needed) and
 * `deposit(amount)`. This balance pays check fees AND publish bonds (the bond
 * is debited from it inside `_publish`, not pulled via transferFrom).
 */
export async function deposit(deps: WriteDeps, amount: bigint): Promise<{ txHash: string }> {
  if (amount <= 0n) throw new Error("deposit amount must be greater than 0");
  await ensureAllowance(deps.usdc, deps.publisher, deps.network.addresses.registry, amount);
  const tx = await deps.registry.deposit(amount);
  await tx.wait();
  return { txHash: tx.hash };
}

/** Withdraw from the operator's free balance back to the wallet. */
export async function withdraw(deps: WriteDeps, amount: bigint): Promise<{ txHash: string }> {
  if (amount <= 0n) throw new Error("withdraw amount must be greater than 0");
  const tx = await deps.registry.withdraw(amount);
  await tx.wait();
  return { txHash: tx.hash };
}

/** The operator's current deposited balance (USDC, 6dp). */
export async function balanceOf(deps: WriteDeps): Promise<bigint> {
  return deps.registry.balances(deps.publisher);
}

/**
 * The full publish pipeline: derive the matcher hash + auxiliary key from the
 * seed, build and upload the evidence envelope (ECIES-encrypting the optional
 * context to the CRE oracle), assemble `PublishParams`, and call
 * `registry.publish`. The bond is debited from the deposited balance inside the
 * contract — there is NO approval for the publish bond. Returns the (locally
 * deterministic) `keccakId` plus the on-chain-assigned `immSeq`/`immId`.
 */
export async function publish(deps: WriteDeps, input: PublishInput): Promise<PublishResult> {
  const { seed } = input;
  const primaryMatcherHash = primaryMatcherHashFor(seed);
  const auxiliaryKey = auxiliaryKeyFor(seed);
  const flavor = flavorCodeOf(seed);
  const keccakId = computeKeccakId(seed.abType, flavor, primaryMatcherHash, deps.publisher);

  // Public, plaintext envelope. `immId` needs the on-chain `immSeq` (assigned at
  // publish), so it is provisional here; the durable link is `keccakId`. The
  // real immId is returned in PublishResult.
  const createdAt = new Date();
  const envelope: PublicEnvelopeV1 = {
    schema: "immunity/antibody-envelope/v1",
    keccakId,
    immId: "",
    abType: seed.abType,
    flavor,
    publisher: deps.publisher,
    createdAt: createdAt.toISOString(),
    reasonSummary: input.reasonSummary,
    ...(input.attestation ? { attestation: input.attestation } : {}),
    matcher: matcherSummaryFor(seed),
  };

  const encrypted = input.context
    ? encryptContext(input.context, deps.network.creOraclePublicKey)
    : undefined;
  const uploaded = await deps.storage.putEvidence(envelope, encrypted);

  const params = buildPublishParams(input, {
    primaryMatcherHash,
    auxiliaryKey,
    evidenceCid: uploaded.evidenceCid,
    contextHash: uploaded.contextHash,
  });

  const txHash = await sendPublish(deps, params, keccakId);
  const ab = await deps.registry.getAntibody(keccakId);
  const immSeq = Number(ab.immSeq);

  return {
    keccakId,
    immSeq,
    immId: formatImmId(createdAt.getFullYear(), immSeq),
    evidenceCid: uploaded.evidenceCid,
    ...(uploaded.contextHash ? { contextHash: uploaded.contextHash } : {}),
    txHash,
  };
}

/**
 * Corroborate an existing matcher: publish under the agent's OWN identity for
 * the same seed/matcher. The on-chain `keccakId` includes the publisher, so this
 * is a distinct antibody sharing the `primaryMatcherHash` — driving
 * `corroboration` toward K (maturation), not colliding with the original.
 */
export async function corroborate(deps: WriteDeps, input: PublishInput): Promise<PublishResult> {
  return publish(deps, input);
}

/**
 * Challenge an antibody: post a bond `max(minChallengeBond, antibodyBond ×
 * challengeBondBps / 1e4)` (the ChallengeManager pulls it via `transferFrom`, so
 * approve the ChallengeManager). Returns the bond staked so the caller knows.
 */
export async function challenge(
  deps: WriteDeps,
  antibodyId: string,
): Promise<{ bond: bigint; txHash: string }> {
  const ab = await deps.registry.getAntibody(antibodyId);
  const antibodyBond = BigInt(ab.bondAmount);
  const bps = BigInt(await deps.challengeManager.challengeBondBps());
  const min = await deps.challengeManager.minChallengeBond();
  const scaled = (antibodyBond * bps) / 10_000n;
  const bond = scaled < min ? min : scaled;

  await ensureAllowance(deps.usdc, deps.publisher, deps.network.addresses.challengeManager, bond);
  const tx = await deps.challengeManager.challenge(antibodyId);
  await tx.wait();
  return { bond, txHash: tx.hash };
}

/** Permissionless poke that promotes a PROBATION antibody to ACTIVE once mature. */
export async function mature(deps: WriteDeps, antibodyId: string): Promise<{ txHash: string }> {
  const tx = await deps.registry.mature(antibodyId);
  await tx.wait();
  return { txHash: tx.hash };
}

/** Send + confirm a publish tx, translating known reverts to typed errors. */
async function sendPublish(
  deps: WriteDeps,
  params: PublishParams,
  keccakId: Hex32,
): Promise<string> {
  try {
    const tx = await deps.registry.publish(params);
    await tx.wait();
    return tx.hash;
  } catch (err) {
    mapRevert(err, { keccakId });
  }
}
