import { AbiCoder, keccak256 } from "ethers";
import type { NovelVerifier } from "../check/verifier.js";
import { encryptContext } from "../storage/crypto.js";
import type { Hex32 } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { TeeAttestationError, TeeResponseError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import { type RawVerdict, parseVerdict } from "./parse.js";
import { distillBundle } from "./prompt.js";

const log = createLogger("cre-verifier");

/**
 * CRE-backed Tier-3 `NovelVerifier` (S6) — the per-check leg of the ENShell
 * firewall model.
 *
 * The locked economics: the mandatory `Registry.check()` fee funds the compute,
 * so EVERY novel (cache-miss) action runs through the CRE TEE — attested — each
 * time. This verifier is the SDK side of that:
 *
 *   1. distill the check context into a bundle (`distillBundle`);
 *   2. ECIES-encrypt the bundle to the CRE oracle pubkey (`encryptContext`) so
 *      the plaintext only ever exists inside the enclave;
 *   3. POST it to the CRE workflow's HTTP trigger and AWAIT the attested verdict;
 *   4. parse the verdict (`parseVerdict`), recompute the attestation commitment
 *      and check it equals the DON-signed report body, then return a `RawVerdict`
 *      carrying the verified `attestation` so a confirmed threat mints an
 *      attested antibody (S7 → `publish().attestation`).
 *
 * Mechanism path A (resolved): the attested verdict is delivered OFF-CHAIN in
 * the HTTP response — no new contract, no redeploy. The deployed jury-shaped
 * `CREVerdictReceiver` does not fit a novel-action verdict.
 *
 * Fail-closed: any transport error, non-2xx, malformed body, or attestation
 * mismatch THROWS. The orchestrator's verify path catches the throw and fails
 * closed (deny/escalate) — a novel input is never silently allowed.
 *
 * Testnet note: CRE only SIMULATES on testnet, so the live HTTP trigger is
 * exercised via the simulator (`per-check-verify/simulate.sh`). This client is
 * agnostic to that — it speaks plain signed-HTTP to whatever endpoint relays the
 * trigger, and `verifyAttestation: false` lets a sim relay (which cannot produce
 * production DON signatures) still drive the full SDK path end-to-end.
 */
export interface CreVerifierOptions {
  /**
   * The HTTP endpoint that relays the per-check-verify CRE trigger. The SDK
   * POSTs `{ "bundle": "0x<ecies>" }` and reads back the attested verdict JSON.
   */
  workflowUrl: string;
  /** Compressed secp256k1 oracle pubkey (the network preset's `creOraclePublicKey`). */
  oraclePublicKey: string;
  /** Per-request timeout (ms). Default 90_000 (matches the CRE ConfHTTP budget). */
  timeoutMs?: number;
  /**
   * Verify the returned attestation binds the verdict (recompute the commitment
   * hash, check it equals the signed report body, require ≥1 signature).
   * Default `true`. Set `false` ONLY for the testnet simulator, whose mock
   * report cannot carry production DON signatures.
   */
  verifyAttestation?: boolean;
  /** Injectable fetch (defaults to global `fetch`); lets tests stub the relay. */
  fetchImpl?: typeof fetch;
  /** Optional bearer/HMAC header value for the relay's authorized-key check. */
  authHeader?: { name: string; value: string };
}

/** The attested-verdict envelope the CRE workflow returns (per-check-verdict/v1). */
interface PerCheckVerdictV1 {
  schema: string;
  verdict: unknown;
  verdictHash: string;
  attestation: {
    rawReport: string;
    reportContext: string;
    configDigest: string;
    sigs: Array<{ signature: string; signerId: number }>;
  };
}

// MUST match `per-check-verify/workflow.ts` byte-for-byte: same enum codes, same
// ABI tuple, same keccak256 over the encoding. The commitment binds the verdict
// to the DON signature so the SDK can trust an off-chain-delivered attestation.
const VERDICT_CODE: Record<RawVerdict["verdict"], number> = {
  BENIGN: 0,
  SUSPICIOUS: 1,
  MALICIOUS: 2,
};
const ABTYPE_CODE: Record<RawVerdict["abType"], number> = {
  ADDRESS: 0,
  CALL_PATTERN: 1,
  BYTECODE: 2,
  GRAPH: 3,
  SEMANTIC: 4,
};

/** Recompute the verdict commitment the CRE workflow signed. */
export function verdictCommitment(v: RawVerdict): Hex32 {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint8", "uint8", "uint8", "uint8", "uint8", "string"],
    [
      VERDICT_CODE[v.verdict],
      ABTYPE_CODE[v.abType],
      v.flavor ? 1 : 0,
      v.confidence,
      v.severity,
      v.marker ?? "",
    ],
  );
  return keccak256(encoded) as Hex32;
}

export class CreNovelVerifier implements NovelVerifier {
  readonly #url: string;
  readonly #oracleKey: string;
  readonly #timeoutMs: number;
  readonly #verifyAttestation: boolean;
  readonly #fetch: typeof fetch;
  readonly #authHeader?: { name: string; value: string };

  constructor(opts: CreVerifierOptions) {
    if (!opts.workflowUrl) throw new Error("CreNovelVerifier: workflowUrl is required");
    if (!opts.oraclePublicKey) throw new Error("CreNovelVerifier: oraclePublicKey is required");
    this.#url = opts.workflowUrl;
    this.#oracleKey = opts.oraclePublicKey;
    this.#timeoutMs = opts.timeoutMs ?? 90_000;
    this.#verifyAttestation = opts.verifyAttestation ?? true;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    if (opts.authHeader) this.#authHeader = opts.authHeader;
    if (typeof this.#fetch !== "function") {
      throw new Error("CreNovelVerifier: no fetch available; pass fetchImpl");
    }
  }

  async verify(input: { tx: ProposedTx | null; context: CheckContext }): Promise<RawVerdict> {
    // 1 + 2 — distill, then ECIES-encrypt the bundle to the oracle. Only the CRE
    // TEE (privkey in the Vault DON) can read it.
    const bundle = distillBundle(input.tx, input.context);
    const ciphertext = encryptContext(bundle, this.#oracleKey);

    // 3 — POST to the CRE workflow's HTTP trigger and AWAIT the verdict.
    const body = await this.#post({ bundle: ciphertext });

    // 4 — parse + verify the attestation binds the verdict, then carry it.
    const verdict = parseVerdict(JSON.stringify(body.verdict));
    if (this.#verifyAttestation) {
      this.#checkAttestation(verdict, body);
    }
    const attestation = (body.verdictHash ?? verdictCommitment(verdict)) as Hex32;
    log.info("tier-3 verdict", {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      attested: this.#verifyAttestation,
    });
    return { ...verdict, attestation };
  }

  /** POST the encrypted bundle; reject (→ fail-closed) on transport/HTTP errors. */
  async #post(payload: { bundle: string }): Promise<PerCheckVerdictV1> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#authHeader ? { [this.#authHeader.name]: this.#authHeader.value } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new TeeResponseError(`CRE workflow returned HTTP ${res.status}`);
    }
    let parsed: unknown;
    try {
      const raw = await res.text();
      // The CRE simulator wraps the handler's string return in a JSON string;
      // a live relay may return the envelope object directly. Handle both.
      const once = JSON.parse(raw);
      parsed = typeof once === "string" ? JSON.parse(once) : once;
    } catch (err) {
      throw new TeeResponseError("CRE workflow response is not valid JSON", { cause: err });
    }
    if (!isEnvelope(parsed)) {
      throw new TeeResponseError("CRE workflow response missing verdict/attestation fields");
    }
    return parsed;
  }

  /** Verify the DON-signed report body equals the recomputed verdict commitment. */
  #checkAttestation(verdict: RawVerdict, body: PerCheckVerdictV1): void {
    const expected = verdictCommitment(verdict);
    if (body.verdictHash.toLowerCase() !== expected.toLowerCase()) {
      throw new TeeAttestationError(
        `verdict hash mismatch: signed ${body.verdictHash} != recomputed ${expected}`,
      );
    }
    // The report body is `abi.encode(bytes32)` — the trailing 32 bytes are the
    // commitment. Bind the signed report to the verdict the SDK is about to act on.
    const raw = body.attestation.rawReport.toLowerCase();
    if (!raw.endsWith(expected.slice(2).toLowerCase())) {
      throw new TeeAttestationError("signed report body does not contain the verdict commitment");
    }
    if (!Array.isArray(body.attestation.sigs) || body.attestation.sigs.length === 0) {
      throw new TeeAttestationError("attestation carries no DON signatures");
    }
  }
}

function isEnvelope(v: unknown): v is PerCheckVerdictV1 {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.verdictHash === "string" &&
    typeof o.attestation === "object" &&
    o.attestation !== null &&
    "verdict" in o
  );
}
