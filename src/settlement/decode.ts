import {
  type AntibodyType,
  AntibodyTypeValue,
  type Status,
  StatusValue,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import type { Address, Antibody, Hex32 } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";

/**
 * Convert a chain-returned Antibody struct (ethers v6 `Result` shape) into
 * the SDK's typed `Antibody`. Enum codes are mapped back to string keys.
 *
 * Hash and address fields are lowercase-normalized so cache lookups are
 * stable regardless of how the upstream node serialized them.
 */
export interface ChainAntibody {
  primaryMatcherHash: string;
  evidenceCid: string;
  contextHash: string;
  embeddingHash: string;
  attestation: string;
  publisher: string;
  stakeLockUntil: bigint;
  immSeq: bigint;
  reviewer: string;
  expiresAt: bigint;
  abType: bigint;
  flavor: bigint;
  verdict: bigint;
  confidence: bigint;
  createdAt: bigint;
  stakeAmount: bigint;
  severity: bigint;
  status: bigint;
  isSeeded: bigint;
}

const ANTIBODY_TYPE_BY_CODE = invert(AntibodyTypeValue) as Record<number, AntibodyType>;
const VERDICT_BY_CODE = invert(VerdictValue) as Record<number, Verdict>;
const STATUS_BY_CODE = invert(StatusValue) as Record<number, Status>;

export function decodeAntibody(struct: ChainAntibody, keccakId: Hex32): Antibody {
  const abType = enumOrThrow(ANTIBODY_TYPE_BY_CODE, Number(struct.abType), "abType");
  const verdict = enumOrThrow(VERDICT_BY_CODE, Number(struct.verdict), "verdict");
  const status = enumOrThrow(STATUS_BY_CODE, Number(struct.status), "status");
  const seq = Number(struct.immSeq);
  return {
    keccakId: keccakId.toLowerCase() as Hex32,
    immSeq: seq,
    immId: `IMM-${immYearFor(struct.createdAt)}-${String(seq).padStart(4, "0")}`,
    abType,
    flavor: Number(struct.flavor),
    verdict,
    status,
    confidence: Number(struct.confidence),
    severity: Number(struct.severity),
    primaryMatcherHash: lower(struct.primaryMatcherHash),
    evidenceCid: lower(struct.evidenceCid),
    contextHash: lower(struct.contextHash),
    embeddingHash: lower(struct.embeddingHash),
    attestation: lower(struct.attestation),
    publisher: normalizeAddress(struct.publisher) as Address,
    reviewer: normalizeAddress(struct.reviewer) as Address,
    stakeAmount: struct.stakeAmount,
    stakeLockUntil: struct.stakeLockUntil,
    expiresAt: struct.expiresAt,
    createdAt: struct.createdAt,
    isSeeded: struct.isSeeded > 0n,
  };
}

function lower(s: string): Hex32 {
  return s.toLowerCase() as Hex32;
}

function immYearFor(createdAt: bigint): number {
  const t = Number(createdAt) * 1000;
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : 1970;
}

function enumOrThrow<T>(map: Record<number, T>, code: number, label: string): T {
  const v = map[code];
  if (v === undefined) throw new Error(`unknown ${label} code: ${code}`);
  return v;
}

function invert<K extends string, V extends number>(
  obj: Record<K, V>,
): Record<V, K> {
  const out = {} as Record<V, K>;
  for (const k of Object.keys(obj) as K[]) out[obj[k]] = k;
  return out;
}
