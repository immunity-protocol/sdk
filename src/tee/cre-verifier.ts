import { AbiCoder, keccak256, randomBytes } from "ethers";
import type { NovelVerifier } from "../check/verifier.js";
import { withTimeout } from "../check/verifier.js";
import type { EciesBundle } from "../storage/crypto.js";
import { encryptContext } from "../storage/crypto.js";
import type { Address, AntibodyType, Hex32 } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { TeeResponseError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import type { RawVerdict } from "./parse.js";
import { distillBundle } from "./prompt.js";

const log = createLogger("cre-verifier");

/**
 * CRE-backed Tier-3 `NovelVerifier` (S6) — the per-check leg of the ENShell
 * firewall model, wired through the LOCKED on-chain trigger (Path B).
 *
 * The locked economics: the mandatory check fee funds the compute, so EVERY
 * novel (cache-miss) action runs through the CRE TEE — attested — each time.
 * This verifier is the SDK side of that:
 *
 *   1. distill the check context into a bundle (`distillBundle`);
 *   2. ECIES-encrypt the bundle to the CRE oracle pubkey (`encryptContext`) so
 *      the plaintext only ever exists inside the enclave;
 *   3. UPLOAD the public envelope + encrypted context via the keyless storage
 *      gateway → `evidenceCid` + `contextHash`;
 *   4. derive a deterministic, unique `checkId` and call
 *      `NovelVerification.requestVerification(checkId, evidenceCid, contextHash)`
 *      with the agent's OWN wallet (which pays the `checkFee` in USDC — the SDK
 *      ensures the allowance first);
 *   5. AWAIT the DON-signed verdict by watching `Verified(checkId, …)` /
 *      polling `verdictOf(checkId)`;
 *   6. map the on-chain verdict enum into the SDK's `RawVerdict`, carrying the
 *      verdict commitment as the `attestation` so a confirmed threat mints an
 *      attested antibody (S7 → `publish().attestation`).
 *
 * Mechanism path B (LOCKED): the verdict is triggered by an on-chain tx and
 * delivered by a DON-signed `Verified` event — NOT by an off-chain HTTP POST.
 * The SDK holds NO secrets; it only uses the agent's own wallet/signer. The
 * model key and oracle private key live in the CRE Vault DON.
 *
 * Fail-closed: any upload error, request revert, timeout, missing verdict, or
 * unparseable verdict THROWS. The orchestrator's verify path catches the throw
 * and fails closed (deny/escalate) — a novel input is never silently allowed.
 * No synthesized benign verdict on error.
 */

/** Hashes the gateway returns/computes for an uploaded evidence object. */
export interface UploadedEvidence {
  /** On-chain `evidenceCid` (the public envelope's 32-byte multihash digest). */
  evidenceCid: Hex32;
  /** On-chain `contextHash` (the encrypted-context object's digest). */
  contextHash: Hex32;
}

/**
 * Keyless upload of the public envelope + ECIES context to the storage gateway.
 * Mirrors the publish-evidence path; injected so tests run without network.
 */
export type EvidenceUploader = (input: {
  envelope: PerCheckEnvelopeV1;
  encryptedContext: EciesBundle;
}) => Promise<UploadedEvidence>;

/** The on-chain verdict as read from the contract (enum: 0/1/2 + 0–100 dims). */
export interface OnChainVerdict {
  /** Contract enum: BENIGN=0, SUSPICIOUS=1, MALICIOUS=2. */
  verdict: number;
  confidence: number;
  severity: number;
}

/**
 * The subset of the deployed `NovelVerification` contract this verifier drives.
 * Structural (like the rest of the SDK's contract seams) so a real ethers
 * `Contract` satisfies it via a cast and tests inject mocks.
 */
export interface NovelVerificationLike {
  /** The contract's `checkFee` (USDC, 6 decimals). */
  checkFee(): Promise<bigint>;
  /** Trigger CRE: pulls `checkFee` via `transferFrom`, emits `VerificationRequested`. */
  requestVerification(
    checkId: Hex32,
    evidenceCid: Hex32,
    contextHash: Hex32,
  ): Promise<{ hash: string; wait(): Promise<unknown> }>;
  /** Read the stored verdict; `at === 0` means no verdict yet. */
  verdictOf(checkId: Hex32): Promise<{
    verdict: bigint | number;
    confidence: bigint | number;
    severity: bigint | number;
    at: bigint | number;
  }>;
}

/** The USDC methods needed to fund the request (approve/allowance). */
export interface Erc20Like {
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<{ hash: string; wait(): Promise<unknown> }>;
}

/** The minimal public envelope uploaded alongside the encrypted context. */
export interface PerCheckEnvelopeV1 {
  schema: "immunity/per-check-request/v1";
  requester: Address;
  /** keccak256 of the distilled bundle (binds the public envelope to the input). */
  bundleHash: Hex32;
  /** Per-request nonce (also folded into `checkId` for uniqueness). */
  nonce: Hex32;
  createdAt: string;
}

export interface CreVerifierOptions {
  /** The agent's wallet address (the `requester`; pays the check fee). */
  requester: Address;
  /** The deployed `NovelVerification` contract (signer-bound). */
  contract: NovelVerificationLike;
  /** Its on-chain address (the USDC approval spender). */
  contractAddress: Address;
  /** USDC token (signer-bound) — funds the check fee. */
  usdc: Erc20Like;
  /** Compressed secp256k1 oracle pubkey (the network preset's `creOraclePublicKey`). */
  oraclePublicKey: string;
  /** Keyless evidence upload (public envelope + ECIES context) → on-chain hashes. */
  upload: EvidenceUploader;
  /** Total budget (ms) to await the DON verdict. Default 90_000. */
  timeoutMs?: number;
  /** Poll interval (ms) for `verdictOf`. Default 2_000. */
  pollIntervalMs?: number;
  /** Injectable clock/sleep (tests stub it; defaults to real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable nonce source (tests pin it; defaults to `randomBytes`). */
  nonce?: () => Hex32;
}

/** Contract verdict enum → SDK `RawVerdict.verdict`. */
const CONTRACT_VERDICT: Record<number, RawVerdict["verdict"]> = {
  0: "BENIGN",
  1: "SUSPICIOUS",
  2: "MALICIOUS",
};

/**
 * Recompute the verdict commitment the CRE workflow reports on-chain. The DON
 * report body is `abi.encode(checkId, verdict, confidence, severity)`; binding
 * the SDK's carried attestation to the same fields keeps a confirmed novel
 * threat's antibody traceable to the exact signed verdict.
 */
export function verdictCommitment(checkId: Hex32, v: OnChainVerdict): Hex32 {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "uint16", "uint8"],
    [checkId, v.verdict, v.confidence, v.severity],
  );
  return keccak256(encoded) as Hex32;
}

export class CreNovelVerifier implements NovelVerifier {
  readonly #requester: Address;
  readonly #contract: NovelVerificationLike;
  readonly #contractAddress: Address;
  readonly #usdc: Erc20Like;
  readonly #oracleKey: string;
  readonly #upload: EvidenceUploader;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #nonce: () => Hex32;

  constructor(opts: CreVerifierOptions) {
    if (!opts.requester) throw new Error("CreNovelVerifier: requester is required");
    if (!opts.contract) throw new Error("CreNovelVerifier: contract is required");
    if (!opts.contractAddress) throw new Error("CreNovelVerifier: contractAddress is required");
    if (!opts.usdc) throw new Error("CreNovelVerifier: usdc is required");
    if (!opts.oraclePublicKey) throw new Error("CreNovelVerifier: oraclePublicKey is required");
    if (!opts.upload) throw new Error("CreNovelVerifier: upload is required");
    this.#requester = opts.requester;
    this.#contract = opts.contract;
    this.#contractAddress = opts.contractAddress;
    this.#usdc = opts.usdc;
    this.#oracleKey = opts.oraclePublicKey;
    this.#upload = opts.upload;
    this.#timeoutMs = opts.timeoutMs ?? 90_000;
    this.#pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#nonce = opts.nonce ?? (() => (`0x${toHex(randomBytes(32))}` as Hex32));
  }

  async verify(input: { tx: ProposedTx | null; context: CheckContext }): Promise<RawVerdict> {
    // 1 + 2 — distill, then ECIES-encrypt the bundle to the oracle. Only the CRE
    // TEE (privkey in the Vault DON) can read it.
    const bundle = distillBundle(input.tx, input.context);
    const encryptedContext = encryptContext(bundle, this.#oracleKey);
    const bundleHash = keccak256(new TextEncoder().encode(bundle)) as Hex32;

    // 3 — upload the public envelope + encrypted context via the gateway.
    const nonce = this.#nonce();
    const envelope: PerCheckEnvelopeV1 = {
      schema: "immunity/per-check-request/v1",
      requester: this.#requester,
      bundleHash,
      nonce,
      createdAt: new Date().toISOString(),
    };
    const { evidenceCid, contextHash } = await this.#upload({ envelope, encryptedContext });

    // 4 — deterministic, unique checkId = keccak256(abi.encode(requester, nonce, bundleHash)).
    const checkId = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["address", "bytes32", "bytes32"],
        [this.#requester, nonce, bundleHash],
      ),
    ) as Hex32;

    // 5 — ensure the USDC allowance, then trigger CRE on-chain (the wallet pays).
    const fee = await this.#contract.checkFee();
    await this.#ensureAllowance(fee);
    const tx = await this.#contract.requestVerification(checkId, evidenceCid, contextHash);
    await tx.wait();
    log.info("tier-3 request submitted", { checkId, evidenceCid, txHash: tx.hash });

    // 6 — await the DON-signed verdict (fail-closed on timeout / no verdict).
    const onChain = await withTimeout(this.#awaitVerdict(checkId), this.#timeoutMs, "cre-verdict");

    // 7 — map the contract enum into the SDK's RawVerdict, carrying the commitment.
    const verdict = this.#toRawVerdict(checkId, onChain, input);
    log.info("tier-3 verdict", {
      checkId,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
    });
    return verdict;
  }

  /** Approve USDC to the contract when the current allowance is short of the fee. */
  async #ensureAllowance(fee: bigint): Promise<void> {
    if (fee <= 0n) return;
    const current = await this.#usdc.allowance(this.#requester, this.#contractAddress);
    if (current >= fee) return;
    await (await this.#usdc.approve(this.#contractAddress, fee)).wait();
  }

  /**
   * Poll `verdictOf(checkId)` until `at > 0` (a verdict was written). Caller
   * wraps this in `withTimeout`, so an indefinitely-pending verdict fails closed.
   */
  async #awaitVerdict(checkId: Hex32): Promise<OnChainVerdict> {
    for (;;) {
      const v = await this.#contract.verdictOf(checkId);
      if (Number(v.at) > 0) {
        return {
          verdict: Number(v.verdict),
          confidence: Number(v.confidence),
          severity: Number(v.severity),
        };
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  /** Translate the on-chain verdict tuple into a typed `RawVerdict`. */
  #toRawVerdict(
    checkId: Hex32,
    v: OnChainVerdict,
    input: { tx: ProposedTx | null; context: CheckContext },
  ): RawVerdict {
    const verdict = CONTRACT_VERDICT[v.verdict];
    if (verdict === undefined) {
      throw new TeeResponseError(`unknown on-chain verdict code ${v.verdict}`);
    }
    if (!inRange(v.confidence) || !inRange(v.severity)) {
      throw new TeeResponseError("on-chain confidence/severity out of [0,100]");
    }
    // The contract verdict has no abType/marker dimension; the SDK seeds an
    // ADDRESS antibody from the tx when one is present, else SEMANTIC from the
    // content. `seedFromTx` re-validates downstream; here we only pick the type.
    const abType: AntibodyType = input.tx ? "ADDRESS" : "SEMANTIC";
    return {
      verdict,
      abType,
      flavor: null,
      confidence: v.confidence,
      severity: v.severity,
      reasoning: `CRE on-chain verdict (checkId ${checkId})`,
      marker: null,
      attestation: verdictCommitment(checkId, v),
    };
  }
}

function inRange(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 100;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
