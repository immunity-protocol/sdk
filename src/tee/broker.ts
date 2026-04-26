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
   * If `true`, ensure the ledger has at least `minLedgerOg` 0G and the
   * provider sub-account holds at least `minProviderOg` 0G before returning.
   * Off by default so library construction is non-mutating; the integration
   * tests / CLI bootstrap flow flip it on.
   */
  ensureFunded?: boolean;
  minLedgerOg?: number;
  minProviderOg?: number;
}

/**
 * Initialize the 0G Compute broker, discover services, and bind to a
 * preferred chatbot provider (default: first chatbot in the catalog, or
 * a configured `preferredProvider`).
 *
 * Funding is left to the caller unless `ensureFunded` is set: the broker
 * has hard minimums (3 0G ledger, 1 0G per-provider) and we don't want
 * silent on-chain spend during library construction.
 */
export async function initTeeBroker(opts: TeeBrokerOptions): Promise<TeeBroker> {
  const broker = await createZGComputeNetworkBroker(
    opts.signer as unknown as Parameters<typeof createZGComputeNetworkBroker>[0],
  );

  if (opts.ensureFunded) {
    await ensureFunded(broker, opts);
  }

  const services = await broker.inference.listService();
  const candidate =
    (opts.preferredProvider
      ? services.find(
          (s) => s.provider.toLowerCase() === opts.preferredProvider?.toLowerCase(),
        )
      : undefined) ?? services.find((s) => s.serviceType === "chatbot") ?? services[0];
  if (!candidate) throw new TeeAttestationError("no inference services discovered");

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

async function ensureFunded(
  broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
  opts: TeeBrokerOptions,
): Promise<void> {
  const minLedger = opts.minLedgerOg ?? 3;
  const minProvider = opts.minProviderOg ?? 1;
  try {
    await broker.ledger.getLedger();
  } catch {
    log.info("ledger missing — creating with minimum deposit", { minLedger });
    await broker.ledger.addLedger(minLedger);
  }
  if (opts.preferredProvider) {
    try {
      await broker.ledger.transferFund(
        opts.preferredProvider,
        "inference",
        ethers.parseEther(String(minProvider)),
      );
    } catch (err) {
      log.warn("transferFund failed (may already be funded)", err);
    }
  }
}
