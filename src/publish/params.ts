import {
  type Address,
  type AntibodySeed,
  AntibodyTypeValue,
  type Hex32,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import { flavorCodeOf } from "./seed.js";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex32;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The high-level publish request: a typed `AntibodySeed` (the matcher) plus the
 * verdict/severity, a public reason for the evidence envelope, and optional
 * sensitive context (ECIES-encrypted before upload).
 */
export interface PublishInput {
  seed: AntibodySeed;
  verdict: Verdict;
  /** 0–100. */
  confidence: number;
  /** 0–100 (scales the publish bond). */
  severity: number;
  /** Short public summary embedded in the (plaintext) evidence envelope. */
  reasonSummary: string;
  /** Optional sensitive context, ECIES-encrypted to the CRE oracle before upload. */
  context?: string;
  /** TTL in Unix seconds; `0`/omitted = permanent. A finite value must be in the future. */
  expiresAt?: number | bigint;
  /** Optional designated reviewer; defaults to the publisher on-chain. */
  reviewer?: Address;
  embeddingHash?: Hex32;
  attestation?: Hex32;
}

/** The on-chain `ImmunityRegistry.PublishParams` struct (field names match the ABI). */
export interface PublishParams {
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

/** The outcome of a successful publish. */
export interface PublishResult {
  keccakId: Hex32;
  immSeq: number;
  immId: string;
  evidenceCid: Hex32;
  contextHash?: Hex32;
  txHash: string;
}

/**
 * Assemble `PublishParams` from a `PublishInput` and the derived on-chain refs
 * (matcher hash, auxiliary key, uploaded CIDs). Pure. Numeric enums map via the
 * canonical value tables; absent hashes default to zero.
 */
export function buildPublishParams(
  input: PublishInput,
  refs: {
    primaryMatcherHash: Hex32;
    auxiliaryKey: Hex32;
    evidenceCid: Hex32;
    contextHash?: Hex32 | undefined;
  },
): PublishParams {
  if (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100) {
    throw new Error(`confidence must be an integer 0–100, got ${input.confidence}`);
  }
  if (!Number.isInteger(input.severity) || input.severity < 0 || input.severity > 100) {
    throw new Error(`severity must be an integer 0–100, got ${input.severity}`);
  }
  return {
    abType: AntibodyTypeValue[input.seed.abType],
    flavor: flavorCodeOf(input.seed),
    verdict: VerdictValue[input.verdict],
    confidence: input.confidence,
    severity: input.severity,
    primaryMatcherHash: refs.primaryMatcherHash,
    evidenceCid: refs.evidenceCid,
    contextHash: refs.contextHash ?? ZERO_BYTES32,
    embeddingHash: input.embeddingHash ?? ZERO_BYTES32,
    attestation: input.attestation ?? ZERO_BYTES32,
    expiresAt: input.expiresAt === undefined ? 0n : BigInt(input.expiresAt),
    reviewer: input.reviewer ?? ZERO_ADDRESS,
    auxiliaryKey: refs.auxiliaryKey,
  };
}
