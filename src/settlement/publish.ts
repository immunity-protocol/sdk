import { zeroPadValue } from "ethers";
import { computeKeccakId } from "../keccak/id.js";
import { hashAddressMatcher } from "../keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../keccak/matchers/call-pattern.js";
import { computeTaintSetId, hashGraphMatcher } from "../keccak/matchers/graph.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import type { PublicEnvelopeV1, PublicMatcherSummary } from "../storage/envelope.js";
import { uploadPublicEnvelope } from "../storage/envelope.js";
import type { StorageClient } from "../storage/indexer.js";
import { uploadEncryptedContext } from "../storage/upload.js";
import {
  type AntibodySeed,
  AntibodyTypeValue,
  type Hex32,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import type { Address } from "../types/antibody.js";
import { DuplicateAntibodyError } from "../types/errors.js";
import { normalizeAddress } from "../util/address.js";
import type { RegistryClient } from "./registry-client.js";

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface PublishInput {
  seed: AntibodySeed;
  verdict: Verdict;
  confidence: number;
  severity: number;
  /**
   * Short, redacted reasoning surfaced to indexers, explorers, and peer
   * agents via the public envelope on 0G storage. Required: omitting this
   * is what produces the "no reasoning recorded" UI state.
   */
  reasonSummary: string;
  /**
   * Full unredacted evidence bytes. When provided, the SDK encrypts the
   * payload (AES-256-GCM with a fresh per-publish key) and uploads the
   * ciphertext to 0G Storage; the resulting Merkle root lands on-chain as
   * `contextHash`. Discarded if omitted.
   *
   * v1: the AES key is dropped after upload (audit-trail only).
   * v2: the key will be wrapped to the TEE's attested encryption pubkey
   * once 0G Compute exposes one.
   */
  evidence?: Uint8Array;
  /**
   * Override the matcher summary the SDK derives from `seed`. Most callers
   * should leave this undefined.
   */
  matcherSummaryHint?: PublicMatcherSummary;
  /** Skip the envelope upload entirely (advanced, when the caller has already pre-uploaded). */
  evidenceCid?: Hex32;
  /** Skip the encrypted-evidence upload (advanced). */
  contextHash?: Hex32;
  embeddingHash?: Hex32;
  attestation?: Hex32;
  expiresAt?: bigint;
  reviewer?: Address;
}

export interface PublishParamsStruct {
  abType: number;
  flavor: number;
  verdict: number;
  confidence: number;
  severity: number;
  primaryMatcherHash: Hex32;
  evidenceCid: Hex32;
  contextHash: Hex32;
  embeddingHash: Hex32;
  attestation: Hex32;
  expiresAt: bigint;
  reviewer: Address;
  auxiliaryKey: Hex32;
}

export interface PublishResult {
  keccakId: Hex32;
  immSeq: number;
  txHash: Hex32;
  params: PublishParamsStruct;
  /** Merkle root of the public envelope on 0G Storage. */
  evidenceCid: Hex32;
  /** Merkle root of the encrypted evidence on 0G Storage, if any was supplied. */
  contextHash?: Hex32;
}

/**
 * Build the on-chain `PublishParams` struct from a seed plus envelope
 * fields. Computes `primaryMatcherHash` and `auxiliaryKey` per type
 * according to the Registry's `_emitAuxiliary` dispatch.
 */
export function buildPublishParams(input: PublishInput): PublishParamsStruct {
  const { seed } = input;
  const flavor = seed.abType === "SEMANTIC" ? semanticFlavorCode(seed.flavor) : 0;
  const primaryMatcherHash = primaryHashFor(seed);
  const auxiliaryKey = auxiliaryKeyFor(seed);
  return {
    abType: AntibodyTypeValue[seed.abType],
    flavor,
    verdict: VerdictValue[input.verdict],
    confidence: clamp(input.confidence, 0, 100),
    severity: clamp(input.severity, 0, 100),
    primaryMatcherHash,
    evidenceCid: input.evidenceCid ?? ZERO_BYTES32,
    contextHash: input.contextHash ?? ZERO_BYTES32,
    embeddingHash: input.embeddingHash ?? ZERO_BYTES32,
    attestation: input.attestation ?? ZERO_BYTES32,
    expiresAt: input.expiresAt ?? 0n,
    reviewer: (input.reviewer ?? "0x0000000000000000000000000000000000000000") as Address,
    auxiliaryKey,
  };
}

/**
 * End-to-end publish:
 *   1. Upload the public envelope (matcher + reasonSummary) to 0G Storage
 *      → produces `evidenceCid`. Skipped only if the caller pre-supplies one.
 *   2. If `evidence` bytes are provided, encrypt + upload them
 *      → produces `contextHash`. Otherwise `contextHash` stays zero.
 *   3. Send `Registry.publish(params)` with both CIDs populated.
 *   4. Parse `AntibodyPublished` for `immSeq`.
 *
 * Mapping the Registry's `AntibodyExists` revert into a typed
 * `DuplicateAntibodyError`. Storage uploads fail fast; on-chain tx failures
 * after a successful upload leave orphan blobs on 0G storage (low-cost,
 * acceptable trade for atomic-style API surface).
 */
export async function publish(
  registry: RegistryClient,
  storage: StorageClient,
  publisher: Address,
  input: PublishInput,
): Promise<PublishResult> {
  const normalizedPublisher = normalizeAddress(publisher) as Address;
  const flavor = input.seed.abType === "SEMANTIC" ? semanticFlavorCode(input.seed.flavor) : 0;
  const primaryMatcherHash = primaryHashFor(input.seed);
  const keccakId = computeKeccakId(
    input.seed.abType,
    flavor,
    primaryMatcherHash,
    normalizedPublisher,
  );

  // 1. Public envelope → evidenceCid
  let evidenceCid = input.evidenceCid;
  if (!evidenceCid || evidenceCid === ZERO_BYTES32) {
    const envelope: PublicEnvelopeV1 = {
      schema: "immunity/antibody-envelope/v1",
      keccakId,
      immId: "",
      abType: input.seed.abType,
      flavor,
      publisher: normalizedPublisher,
      createdAt: new Date().toISOString(),
      reasonSummary: input.reasonSummary,
      matcher: input.matcherSummaryHint ?? matcherSummaryFor(input.seed),
      ...(input.attestation ? { attestation: input.attestation } : {}),
    };
    const upload = await uploadPublicEnvelope(storage, envelope);
    evidenceCid = upload.evidenceCid;
  }

  // 2. Encrypted evidence → contextHash (optional)
  let contextHash = input.contextHash;
  if ((!contextHash || contextHash === ZERO_BYTES32) && input.evidence) {
    const upload = await uploadEncryptedContext(storage, input.evidence);
    contextHash = upload.contextHash;
    // upload.key intentionally discarded (v1 audit-trail only).
  }

  // 3. On-chain publish with the resolved CIDs.
  const params = buildPublishParams({
    ...input,
    evidenceCid,
    ...(contextHash ? { contextHash } : {}),
  });

  let tx: Awaited<ReturnType<typeof registry.contract.publish>>;
  try {
    tx = await registry.contract.publish(params);
  } catch (err) {
    if (looksLikeDuplicate(err)) throw new DuplicateAntibodyError(keccakId);
    throw err;
  }
  const receipt = await tx.wait();
  const eventLog = (receipt?.logs ?? [])
    .map((l: { topics: ReadonlyArray<string>; data: string }) => {
      try {
        return registry.contract.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        return null;
      }
    })
    .find((l: { name: string } | null) => l?.name === "AntibodyPublished");
  const immSeq = eventLog ? Number(eventLog.args.immSeq as bigint) : 0;
  return {
    keccakId,
    immSeq,
    txHash: (receipt?.hash ?? tx.hash) as Hex32,
    params,
    evidenceCid,
    ...(contextHash ? { contextHash } : {}),
  };
}

/**
 * Build the public matcher summary the indexer hydrates from. Mirrors the
 * dispatch in `primaryHashFor` so envelope and on-chain hash stay in lockstep.
 */
function matcherSummaryFor(seed: AntibodySeed): PublicMatcherSummary {
  switch (seed.abType) {
    case "ADDRESS":
      return {
        kind: "address",
        chainId: seed.chainId,
        target: normalizeAddress(seed.target) as Address,
      };
    case "CALL_PATTERN":
      return {
        kind: "call_pattern",
        chainId: seed.chainId,
        target: normalizeAddress(seed.target) as Address,
        selector: seed.selector,
      };
    case "BYTECODE":
      return { kind: "bytecode", bytecodeHash: seed.bytecodeHash };
    case "GRAPH":
      return {
        kind: "graph",
        chainId: seed.chainId,
        taintSetId: computeTaintSetId({
          chainId: seed.chainId,
          taintedAddresses: seed.taintedAddresses,
        }),
        size: seed.taintedAddresses.length,
      };
    case "SEMANTIC": {
      const markerHint =
        seed.pattern.kind === "marker" ? seed.pattern.value.slice(0, 64) : undefined;
      return {
        kind: "semantic",
        flavor: seed.flavor,
        ...(markerHint ? { markerHint } : {}),
      };
    }
  }
}

function semanticFlavorCode(flavor: "COUNTERPARTY" | "MANIPULATION" | "PROMPT_INJECTION"): number {
  return flavor === "COUNTERPARTY" ? 0 : flavor === "MANIPULATION" ? 1 : 2;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) throw new Error(`expected number in [${lo},${hi}]`);
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function primaryHashFor(seed: AntibodySeed): Hex32 {
  switch (seed.abType) {
    case "ADDRESS":
      return hashAddressMatcher({ chainId: seed.chainId, target: seed.target });
    case "CALL_PATTERN":
      return hashCallPatternMatcher({
        chainId: seed.chainId,
        target: seed.target,
        selector: seed.selector,
        argsTemplate: seed.argsTemplate,
      });
    case "BYTECODE":
      return hashBytecodeMatcher({ bytecodeHash: seed.bytecodeHash });
    case "GRAPH":
      return hashGraphMatcher({
        chainId: seed.chainId,
        taintedAddresses: seed.taintedAddresses,
      });
    case "SEMANTIC":
      return hashSemanticMatcher({ flavor: seed.flavor, pattern: seed.pattern });
  }
}

/**
 * Compute the auxiliaryKey the contract uses to dispatch `_emitAuxiliary`.
 *
 * - ADDRESS: bytes32(uint256(uint160(address))) — the target padded left.
 * - CALL_PATTERN: bytes32 with selector in the leading 4 bytes.
 * - BYTECODE: the runtime bytecode hash directly.
 * - GRAPH: the taintSetId (the inner keccak of the matcher hash).
 * - SEMANTIC: zero — flavor is the indexed event arg, auxKey is unused.
 */
function auxiliaryKeyFor(seed: AntibodySeed): Hex32 {
  switch (seed.abType) {
    case "ADDRESS":
      return zeroPadValue(normalizeAddress(seed.target), 32) as Hex32;
    case "CALL_PATTERN": {
      const sel = seed.selector;
      return `${sel}${"00".repeat(28)}` as Hex32;
    }
    case "BYTECODE":
      return seed.bytecodeHash;
    case "GRAPH":
      return computeTaintSetId({
        chainId: seed.chainId,
        taintedAddresses: seed.taintedAddresses,
      });
    case "SEMANTIC":
      return ZERO_BYTES32;
  }
}

function looksLikeDuplicate(err: unknown): boolean {
  const msg = String((err as { message?: string }).message ?? "");
  return msg.includes("AntibodyExists");
}
