import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";
import { type Signer, ethers } from "ethers";
import type { Address } from "../types/antibody.js";
import { TeeAttestationError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("tee:broker");

/**
 * Active inference service the SDK is bound to: the on-chain provider
 * address plus its discovered model + endpoint. `endpoint` already
 * includes the `/v1/proxy` segment, so callers append `chat/completions`.
 */
export interface TeeService {
  provider: Address;
  model: string;
  endpoint: string;
}

export interface TeeBroker {
  service: TeeService;
  raw: ReturnType<typeof createZGComputeNetworkBroker> extends Promise<infer T> ? T : never;
}

export interface TeeBrokerOptions {
  signer: Signer;
  preferredProvider?: Address;
  /**
   * If `true`, ensure the ledger has at least `minLedgerOg` 0G, register the
   * wallet as authorized for the provider via `acknowledgeProviderSigner`,
   * and fund the provider sub-account with `minProviderOg` 0G before returning.
   * Off by default so library construction is non-mutating; the integration
   * tests / CLI bootstrap flow flip it on.
   */
  ensureFunded?: boolean;
  minLedgerOg?: number;
  minProviderOg?: number;
}

/**
 * Initialize the 0G Compute broker, discover services, ensure the ledger and
 * provider sub-account are funded, register the wallet as an authorized signer
 * with the provider, and bind to a preferred chatbot provider.
 *
 * The funding sequence mirrors what was empirically validated in the
 * zerog-exploration spike (see FINDINGS.md "TEE attestation"):
 *
 *   1. Discover services (cheap, no funds required).
 *   2. Pick a provider (preferred override, else first chatbot).
 *   3. Ensure ledger has 3+ 0G (creates with `addLedger(3)` if missing).
 *   4. `acknowledgeProviderSigner(provider)` — 2 on-chain txs, idempotent.
 *      WITHOUT this, processResponse rejects signatures later. Skipping it
 *      is the most common cause of "TEE inference works but per-response
 *      verification fails" in fresh wallets.
 *   5. `transferFund(provider, "inference", 1 0G)` — provider sub-account.
 *   6. Re-fetch metadata for the chosen provider's endpoint + model.
 */
export async function initTeeBroker(opts: TeeBrokerOptions): Promise<TeeBroker> {
  const broker = await createZGComputeNetworkBroker(
    opts.signer as unknown as Parameters<typeof createZGComputeNetworkBroker>[0],
  );

  // 1-2. Discover services and pick a candidate.
  const services = await broker.inference.listService();
  const candidate =
    (opts.preferredProvider
      ? services.find((s) => s.provider.toLowerCase() === opts.preferredProvider?.toLowerCase())
      : undefined) ??
    services.find((s) => s.serviceType === "chatbot") ??
    services[0];
  if (!candidate) throw new TeeAttestationError("no inference services discovered");

  // 3-5. Optional funding + signer ack.
  if (opts.ensureFunded) {
    await ensureLedger(broker, opts.minLedgerOg ?? 3);
    await acknowledgeSigner(broker, candidate.provider as Address);
    await ensureProviderFunded(broker, candidate.provider as Address, opts.minProviderOg ?? 1);
  }

  // 6. Endpoint + model metadata.
  const meta = await broker.inference.getServiceMetadata(candidate.provider);
  log.info("bound TEE service", {
    provider: candidate.provider,
    model: meta.model,
    endpoint: meta.endpoint,
  });

  return {
    service: {
      provider: candidate.provider.toLowerCase() as Address,
      model: meta.model,
      endpoint: meta.endpoint,
    },
    raw: broker,
  };
}

/**
 * 0G's `LedgerBroker.addLedger` enforces a hard minimum deposit of 3 0G —
 * passing less throws "Minimum balance to create a ledger is 3 0G". The
 * `minLedger` arg here is our *check threshold* (when do we top up?), not
 * the *create amount*, so we floor the initial deposit at the protocol
 * minimum. Callers passing `minLedger < 3` are saying "I want a smaller
 * maintenance threshold," not "I want to skirt the protocol minimum."
 */
const LEDGER_CREATE_MIN_OG = 3;

async function ensureLedger(
  broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
  minLedger: number,
): Promise<void> {
  try {
    await broker.ledger.getLedger();
  } catch {
    const deposit = Math.max(minLedger, LEDGER_CREATE_MIN_OG);
    log.info("ledger missing; creating with protocol minimum deposit", {
      requested: minLedger,
      depositing: deposit,
    });
    await broker.ledger.addLedger(deposit);
  }
}

/**
 * Idempotent registration of the caller as an authorized signer for the
 * given provider. The 0G-compute SDK sends 2 on-chain txs internally; if
 * already acknowledged, the second call typically throws and we swallow it.
 */
async function acknowledgeSigner(
  broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
  provider: Address,
): Promise<void> {
  try {
    await broker.inference.acknowledgeProviderSigner(provider);
    log.info("acknowledged TEE signer", { provider });
  } catch (err) {
    log.info("acknowledgeProviderSigner: already acknowledged or non-fatal", {
      message: (err as { message?: string }).message,
    });
  }
}

async function ensureProviderFunded(
  broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
  provider: Address,
  minProvider: number,
): Promise<void> {
  try {
    await broker.ledger.transferFund(provider, "inference", ethers.parseEther(String(minProvider)));
    log.info("provider sub-account funded", { provider, amount: minProvider });
  } catch (err) {
    log.warn("transferFund non-fatal (may already be funded)", err);
  }
}
