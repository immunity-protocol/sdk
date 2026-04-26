/**
 * Antibody types and enums mirroring the on-chain Registry.
 *
 * The numeric values below MUST match the contract enums byte-for-byte so
 * struct round-trips are stable. See `contracts/interfaces/IRegistry.sol`
 * in the immunity-contracts-0g repo.
 */

export type Hex32 = `0x${string}`;
export type Address = `0x${string}`;

export const AntibodyTypeValue = {
  ADDRESS: 0,
  CALL_PATTERN: 1,
  BYTECODE: 2,
  GRAPH: 3,
  SEMANTIC: 4,
} as const;

export type AntibodyType = keyof typeof AntibodyTypeValue;
export type AntibodyTypeCode = (typeof AntibodyTypeValue)[AntibodyType];

export const VerdictValue = {
  MALICIOUS: 0,
  SUSPICIOUS: 1,
} as const;

export type Verdict = keyof typeof VerdictValue;
export type VerdictCode = (typeof VerdictValue)[Verdict];

export const StatusValue = {
  ACTIVE: 0,
  CHALLENGED: 1,
  SLASHED: 2,
  EXPIRED: 3,
} as const;

export type Status = keyof typeof StatusValue;
export type StatusCode = (typeof StatusValue)[Status];

/**
 * Sub-flavor for SEMANTIC antibodies. Ignored for other types (set to 0).
 *
 * - COUNTERPARTY: malicious counterparty profile (off-chain identity).
 * - MANIPULATION: manipulation / social-engineering pattern.
 * - PROMPT_INJECTION: prompt injection attempt embedded in untrusted content.
 */
export const SemanticFlavorValue = {
  COUNTERPARTY: 0,
  MANIPULATION: 1,
  PROMPT_INJECTION: 2,
} as const;

export type SemanticFlavor = keyof typeof SemanticFlavorValue;
export type SemanticFlavorCode = (typeof SemanticFlavorValue)[SemanticFlavor];

/**
 * Original matcher inputs the publisher used to derive `primaryMatcherHash`.
 *
 * Travels alongside the antibody on gossip envelopes so subscribers can
 * rebuild their type-specific lookup indices without re-querying the chain.
 * Optional because antibodies hydrated directly from chain reads do not
 * have it (the contract stores only the hash).
 */
export type AntibodySeed =
  | { abType: "ADDRESS"; chainId: number; target: Address }
  | {
      abType: "CALL_PATTERN";
      chainId: number;
      target: Address;
      selector: `0x${string}`;
      argsTemplate: `0x${string}`;
    }
  | { abType: "BYTECODE"; bytecodeHash: Hex32 }
  | {
      abType: "GRAPH";
      chainId: number;
      taintedAddresses: Address[];
      taintSetId: Hex32;
    }
  | {
      abType: "SEMANTIC";
      flavor: SemanticFlavor;
      pattern: { kind: "hash"; value: Hex32 } | { kind: "marker"; value: string };
    };

/**
 * Stored antibody envelope.
 *
 * Numeric fields are kept narrow where the contract bound is small
 * (`uint8` -> `number`, `uint64`/`uint96` -> `bigint`). Identifiers and
 * hashes are 0x-prefixed lowercase strings.
 */
export interface Antibody {
  keccakId: Hex32;
  immSeq: number;
  immId: string;
  abType: AntibodyType;
  flavor: number;
  verdict: Verdict;
  status: Status;
  confidence: number;
  severity: number;
  primaryMatcherHash: Hex32;
  evidenceCid: Hex32;
  contextHash: Hex32;
  embeddingHash: Hex32;
  attestation: Hex32;
  publisher: Address;
  reviewer: Address;
  stakeAmount: bigint;
  stakeLockUntil: bigint;
  expiresAt: bigint;
  createdAt: bigint;
  isSeeded: boolean;
  seed?: AntibodySeed;
}

/**
 * Format an `immSeq` as the human-readable `IMM-YYYY-NNNN` identifier.
 *
 * The year segment is informational only: it is derived from the antibody's
 * `createdAt` in callers, not from the seq itself.
 */
export function formatImmId(year: number, immSeq: number): string {
  const padded = String(immSeq).padStart(4, "0");
  return `IMM-${year}-${padded}`;
}
