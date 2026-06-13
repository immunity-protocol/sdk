// Per-publisher seed pipeline + maturation/assertion pass.
//
// Each publisher runs: ensureRegistered → ensureDeposit → publishTarget(×N).
// After ALL publishers have published a target, matureAndAssert promotes the
// three antibodies to ACTIVE and verifies the corroboration / hard-block /
// evidence-round-trip invariants the seed exists to establish.

import type { Signer } from "ethers";
import {
  type Address,
  type EnforcementTier,
  type Hex32,
  type Immunity,
  type NetworkConfig,
  StorageClient,
  classifyEnforcement,
  computeKeccakId,
  decodeEnforcementInputs,
  fetchPublicEnvelope,
} from "../../src/index.js";
import type { CorpusTarget } from "./corpus.js";
import type { SeedLedger } from "./ledger.js";
import { type RawAntibodyView, type RegistryReadOps, buildOnchain } from "./onchain.js";
import { depositTarget } from "./sizing.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex32;

/** A started publisher facade plus its identity. */
export interface PublisherCtx {
  label: string;
  address: Address;
  signer: Signer;
  im: Immunity;
}

export interface PublisherLine {
  label: string;
  address: Address;
  keccakId: Hex32;
  evidenceCid?: string;
  contextHash?: string;
  publishTx?: string;
  matureTx?: string;
  status: string;
  maturedAt: bigint;
}

export interface TargetReport {
  index: number;
  target: Address;
  matcherHash: Hex32;
  isCreDemo: boolean;
  corroboration: number;
  k: number;
  tier: EnforcementTier;
  publishers: PublisherLine[];
  evidenceRoundTrip: boolean;
  failures: string[];
}

/** The on-chain id for this publisher's antibody on this target (publisher-scoped). */
export function keccakIdOf(t: CorpusTarget, publisher: Address): Hex32 {
  return computeKeccakId("ADDRESS", 0, t.matcherHash, publisher);
}

async function readAntibody(
  registry: RegistryReadOps,
  keccakId: string,
): Promise<RawAntibodyView | null> {
  try {
    return await registry.getAntibody(keccakId);
  } catch {
    // Nonexistent ids revert on some deployments — treat as absent.
    return null;
  }
}

function exists(ab: RawAntibodyView | null): boolean {
  return ab !== null && ab.publisher.toLowerCase() !== ZERO_ADDRESS;
}

/** Register the publisher if not already registered (registration bond paid in USDC). */
export async function ensureRegistered(
  ctx: PublisherCtx,
): Promise<{ alreadyRegistered: boolean; txHash?: string; bond?: bigint }> {
  if (await ctx.im.isRegistered()) return { alreadyRegistered: true };
  const { txHash, bond } = await ctx.im.registerPublisher(ctx.label);
  return { alreadyRegistered: false, txHash, bond };
}

/** Deposit enough USDC to cover all publish bonds (with buffer) if the balance is short. */
export async function ensureDeposit(
  ctx: PublisherCtx,
  net: NetworkConfig,
  targets: CorpusTarget[],
): Promise<{ needed: bigint; have: bigint; txHash?: string }> {
  const { registry } = buildOnchain(net, ctx.signer);
  const bonds: bigint[] = [];
  for (const t of targets) bonds.push(await registry.computeBond(t.input.severity, t.target));
  const needed = depositTarget(bonds);
  const have = await ctx.im.balanceOf();
  if (have >= needed) return { needed, have };
  const { txHash } = await ctx.im.deposit(needed - have);
  return { needed, have, txHash };
}

export interface PublishOutcome {
  keccakId: Hex32;
  skipped: "ledger" | "onchain" | null;
  evidenceCid?: string;
  txHash?: string;
}

/** Publish one target for one publisher, skipping if already published (ledger or chain). */
export async function publishTarget(
  ctx: PublisherCtx,
  net: NetworkConfig,
  mode: string,
  t: CorpusTarget,
  ledger: SeedLedger,
): Promise<PublishOutcome> {
  const keccakId = keccakIdOf(t, ctx.address);
  if (ledger.has(mode, ctx.address, t.matcherHash)) {
    const led = ledger.get(mode, ctx.address, t.matcherHash);
    return {
      keccakId,
      skipped: "ledger",
      ...(led ? { evidenceCid: led.evidenceCid, txHash: led.txHash } : {}),
    };
  }

  const { registry } = buildOnchain(net, ctx.signer);
  const existing = await readAntibody(registry, keccakId);
  if (exists(existing) && existing) {
    ledger.record(mode, ctx.address, t.matcherHash, {
      keccakId,
      evidenceCid: existing.evidenceCid,
      txHash: "(pre-existing)",
    });
    return { keccakId, skipped: "onchain", evidenceCid: existing.evidenceCid };
  }

  const result = await ctx.im.publish(t.input);
  ledger.record(mode, ctx.address, t.matcherHash, {
    keccakId: result.keccakId,
    evidenceCid: result.evidenceCid,
    ...(result.contextHash ? { contextHash: result.contextHash } : {}),
    txHash: result.txHash,
  });
  return {
    keccakId: result.keccakId,
    skipped: null,
    evidenceCid: result.evidenceCid,
    txHash: result.txHash,
  };
}

/**
 * Promote all publishers' antibodies for a target to ACTIVE and assert the
 * invariants: corroboration == #publishers, each ACTIVE + matured + hard-block,
 * and the evidence envelope round-trips from the gateway. Never throws on a
 * failed invariant — collects them in `failures` so the full report still
 * prints; the caller decides the exit code.
 */
export async function matureAndAssert(
  net: NetworkConfig,
  readsRunner: Signer,
  ctxs: PublisherCtx[],
  t: CorpusTarget,
  ledger: SeedLedger,
  mode: string,
  storage: StorageClient,
): Promise<TargetReport> {
  const { registry } = buildOnchain(net, readsRunner);
  const k = Number(await registry.corroborationK());
  const corroboration = Number(await registry.corroborationOf(t.matcherHash));
  const failures: string[] = [];
  if (corroboration !== ctxs.length) {
    failures.push(`corroborationOf == ${corroboration}, expected ${ctxs.length}`);
  }

  const publishers: PublisherLine[] = [];
  let tier: EnforcementTier = "none";

  for (const ctx of ctxs) {
    const keccakId = keccakIdOf(t, ctx.address);
    let inputs = decodeEnforcementInputs(await registry.getEnforcementInputs(keccakId));
    let matureTx: string | undefined;
    // mature() is a no-op until corroborationOf >= k is observable on the node the
    // tx executes against; public-RPC load-balancing means a just-confirmed publish
    // may not be visible to the node that runs the mature tx, so a single mature can
    // silently no-op. Poll the precondition, mature, confirm ACTIVE, and retry on lag.
    for (let attempt = 0; attempt < 10 && inputs.status !== "ACTIVE"; attempt++) {
      const observable = Number(await registry.corroborationOf(t.matcherHash));
      if (observable >= k) {
        const r = await ctx.im.mature(keccakId);
        matureTx = r.txHash;
        inputs = decodeEnforcementInputs(await registry.getEnforcementInputs(keccakId));
        if (inputs.status === "ACTIVE") break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const classified = classifyEnforcement(inputs, k, nowSec);
    tier = classified; // symmetric across publishers; representative target tier

    if (inputs.status !== "ACTIVE")
      failures.push(`${ctx.label}: status ${inputs.status} != ACTIVE`);
    if (inputs.maturedAt <= 0n) failures.push(`${ctx.label}: maturedAt not set`);
    if (classified !== "hard-block")
      failures.push(`${ctx.label}: tier ${classified} != hard-block`);

    const led = ledger.get(mode, ctx.address, t.matcherHash);
    const ab = await readAntibody(registry, keccakId);
    publishers.push({
      label: ctx.label,
      address: ctx.address,
      keccakId,
      ...(ab ? { evidenceCid: ab.evidenceCid } : {}),
      ...(led?.contextHash ? { contextHash: led.contextHash } : {}),
      ...(led?.txHash ? { publishTx: led.txHash } : {}),
      ...(matureTx ? { matureTx } : {}),
      status: inputs.status,
      maturedAt: inputs.maturedAt,
    });
  }

  let evidenceRoundTrip = false;
  const firstCid = publishers[0]?.evidenceCid;
  if (firstCid && firstCid !== ZERO_BYTES32) {
    try {
      const env = await fetchPublicEnvelope(storage, firstCid as Hex32);
      evidenceRoundTrip =
        env.matcher.kind === "address" && env.matcher.target.toLowerCase() === t.target;
      if (!evidenceRoundTrip) failures.push("evidence envelope target mismatch");
    } catch (err) {
      failures.push(`evidence round-trip failed: ${(err as Error).message}`);
    }
  } else {
    failures.push("no evidence CID to round-trip");
  }

  return {
    index: t.index,
    target: t.target,
    matcherHash: t.matcherHash,
    isCreDemo: t.isCreDemo,
    corroboration,
    k,
    tier,
    publishers,
    evidenceRoundTrip,
    failures,
  };
}

/** A keyless-read storage client (reads do not sign; any signer satisfies the type). */
export function readStorage(net: NetworkConfig, signer: Signer): StorageClient {
  return new StorageClient({
    storageGatewayUrl: net.storageGatewayUrl,
    lighthouseGateway: net.lighthouseGateway,
    signer,
  });
}
