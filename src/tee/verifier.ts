import type { Signer } from "ethers";
import type { TeeVerifyOutcome } from "../check-flow.js";
import { createStorageClient, type StorageClient } from "../storage/indexer.js";
import { uploadEncryptedContext } from "../storage/upload.js";
import type { Address } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { TeeAttestationError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import { initTeeBroker, type TeeBroker } from "./broker.js";
import { runInference } from "./inference.js";
import { decideFromVerdict, parseVerdict } from "./parse.js";
import { buildVerdictPrompt, distillBundle } from "./prompt.js";
import { seedFromTx } from "./seed-from-tx.js";
import { verifyAttestation } from "./verify.js";

const log = createLogger("tee:verifier");

export interface TeeVerifierOptions {
  signer: Signer;
  rpcUrl: string;
  storageIndexerUrl: string;
  preferredProvider?: Address;
  blockThreshold: number;
  escalateThreshold: number;
  defaultChainId: number;
  /**
   * Open the ledger and fund the provider sub-account on init when missing.
   * Defaults to true. Disable for read-only environments.
   */
  ensureFunded?: boolean;
}

/**
 * Build the `teeVerify` callback expected by `runCheck`.
 *
 * The factory is async because it boots the 0G Compute broker, runs the
 * TEE attestation handshake, and (optionally) tops up the ledger. Once
 * built, each call:
 *
 *   1. distill the (tx, ctx) pair into a bundle
 *   2. AES-256-GCM encrypt the bundle and upload the ciphertext + IV to
 *      0G Storage; record the Merkle root as `contextHash` for the
 *      future antibody envelope
 *   3. send a strict-JSON-output prompt to qwen-2.5-7b-instruct with the
 *      bundle wrapped in an UNTRUSTED_AGENT_CONTEXT fence
 *   4. verify the per-response signature via processResponse (settles the
 *      per-token TEE payment in the same call)
 *   5. parse the response with strict enum validation; reject prose
 *   6. derive an AntibodySeed from observable tx fields ONLY, never from
 *      the LLM's free-text reasoning
 *   7. return a TeeVerifyOutcome the check-flow can act on
 *
 * Step (6) is the injection defense: even an attacker who controls the
 * encrypted bundle cannot pick which address or pattern gets flagged,
 * because the SDK reads tx.to / selector / counterparty.id from the call
 * site, not from the bundle.
 */
export async function createTeeVerifier(
  opts: TeeVerifierOptions,
): Promise<(tx: ProposedTx | null, ctx: CheckContext) => Promise<TeeVerifyOutcome | null>> {
  const broker = await initTeeBroker({
    signer: opts.signer,
    ensureFunded: opts.ensureFunded ?? true,
    ...(opts.preferredProvider ? { preferredProvider: opts.preferredProvider } : {}),
  });
  try {
    await verifyAttestation(broker);
  } catch (err) {
    log.warn("TEE attestation imperfect; continuing (per-response signature is the harder gate)", err);
    if (err instanceof TeeAttestationError && /signer/i.test(err.message)) {
      throw err;
    }
  }
  const storage: StorageClient = createStorageClient({
    indexerUrl: opts.storageIndexerUrl,
    rpcUrl: opts.rpcUrl,
    signer: opts.signer,
  });

  return async (tx, ctx) => {
    const bundle = distillBundle(tx, ctx);
    const upload = await uploadEncryptedContext(storage, new TextEncoder().encode(bundle));
    log.info("context uploaded", {
      contextHash: upload.contextHash,
      txHash: upload.txHash,
      bytes: bundle.length,
    });

    const prompt = buildVerdictPrompt({ bundle });
    const inference = await runInferenceSafely(broker, prompt);
    if (!inference) return null;
    log.info("TEE inference complete", {
      chatId: inference.chatId,
      latencyMs: inference.latencyMs,
      signedAndValid: inference.signedAndValid,
    });

    let raw;
    try {
      raw = parseVerdict(inference.raw);
    } catch (err) {
      log.warn("verdict parse rejected; treating as benign", err);
      return null;
    }
    log.info("TEE verdict parsed", {
      verdict: raw.verdict,
      abType: raw.abType,
      flavor: raw.flavor,
      confidence: raw.confidence,
      severity: raw.severity,
      reasoning: raw.reasoning?.slice(0, 200),
    });

    const decision = decideFromVerdict(raw, opts.blockThreshold, opts.escalateThreshold);
    const seed = seedFromTx(raw, tx, ctx, opts.defaultChainId);
    const outcome = {
      block: decision.treatAsBlock && seed !== null,
      escalate: decision.treatAsEscalate || (decision.treatAsBlock && seed === null),
      reason:
        raw.reasoning ||
        `${raw.verdict}/${raw.abType}@${raw.confidence}`,
      confidence: raw.confidence,
      severity: raw.severity,
      ...(seed ? { publishSeed: seed } : {}),
    };
    log.info("TEE outcome", {
      block: outcome.block,
      escalate: outcome.escalate,
      seedDerived: seed !== null,
      treatAsBlock: decision.treatAsBlock,
      treatAsEscalate: decision.treatAsEscalate,
    });
    return outcome;
  };
}

async function runInferenceSafely(broker: TeeBroker, prompt: string) {
  try {
    return await runInference(broker, prompt);
  } catch (err) {
    log.warn("TEE inference failed; returning null verdict (treat as benign)", err);
    return null;
  }
}
