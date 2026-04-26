import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TeeAttestationError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import type { TeeBroker } from "./broker.js";

const log = createLogger("tee:verify");

export interface AttestationResult {
  signerAllMatch: boolean;
  composePassed: boolean;
  reportDir: string;
}

/**
 * Verify a TEE provider's attestation: confirms (a) the on-chain signer
 * matches the quote and (b) the compose manifest of the running enclave
 * matches what the SDK expects.
 *
 * Reports are written to a temp dir (or a caller-supplied dir) so audit
 * tooling can attach them to a verdict envelope. The caller is responsible
 * for cleaning up the temp dir if it cares about disk hygiene.
 */
export async function verifyAttestation(
  broker: TeeBroker,
  reportDir?: string,
): Promise<AttestationResult> {
  const dir = reportDir ?? mkdtempSync(path.join(tmpdir(), "immunity-tee-"));
  let result: AttestationResult;
  try {
    const att = await broker.raw.inference.verifyService(
      broker.service.provider,
      dir,
      (step: { message?: string }) =>
        log.debug("attestation step", step.message ?? JSON.stringify(step)),
    );
    result = {
      signerAllMatch: Boolean(att?.signerVerification?.allMatch),
      composePassed: Boolean(att?.composeVerification?.passed),
      reportDir: dir,
    };
  } catch (err) {
    if (!reportDir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    throw new TeeAttestationError(`verifyService threw: ${describe(err)}`, { cause: err });
  }
  if (!result.signerAllMatch) {
    throw new TeeAttestationError("signer verification did not match across components");
  }
  return result;
}

function describe(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}
