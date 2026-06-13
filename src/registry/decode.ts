import {
  type Antibody,
  type AntibodyType,
  AntibodyTypeValue,
  formatImmId,
  type Hex32,
  type Status,
  StatusValue,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import type { EnforcementInputs } from "../types/enforcement.js";
import { normalizeAddress } from "../util/address.js";

/**
 * Decoders that turn raw on-chain reads into the SDK's typed shapes.
 *
 * ethers v6 returns every integer as a `bigint` and tuples as a `Result`
 * (array-like with named accessors). These decoders read by named field, so
 * they work against both an ethers `Result` and a plain mock object in tests.
 * Numeric values may arrive as `bigint` (ethers) or `number` (hand-built
 * mocks); both are accepted.
 */

type Numeric = bigint | number;

/** Raw tuple shape of `ImmunityRegistry.getEnforcementInputs`. */
export interface RawEnforcementInputs {
  status: Numeric;
  corroboration: Numeric;
  publisherRep: Numeric;
  prominenceTier: Numeric;
  maturedAt: Numeric;
  expiresAt: Numeric;
  isSeeded: boolean;
}

/**
 * Raw struct shape of `ImmunityRegistry.getAntibody`. `keccakId` is the lookup
 * key, not part of the stored struct, so it is supplied separately.
 * NOTE: `isSeeded` is a `uint8` here (unlike the `bool` in getEnforcementInputs).
 */
export interface RawAntibody {
  primaryMatcherHash: string;
  evidenceCid: string;
  contextHash: string;
  embeddingHash: string;
  attestation: string;
  publisher: string;
  immSeq: Numeric;
  createdAt: Numeric;
  reviewer: string;
  expiresAt: Numeric;
  abType: Numeric;
  flavor: Numeric;
  verdict: Numeric;
  confidence: Numeric;
  bondAmount: Numeric;
  escrowedFees: Numeric;
  maturedAt: Numeric;
  severity: Numeric;
  status: Numeric;
  isSeeded: Numeric;
  prominenceTier: Numeric;
}

// Reverse enum lookups (code -> name), built once from the canonical maps.
const STATUS_BY_CODE = invert(StatusValue);
const ANTIBODY_TYPE_BY_CODE = invert(AntibodyTypeValue);
const VERDICT_BY_CODE = invert(VerdictValue);

function invert<T extends Record<string, number>>(map: T): Map<number, keyof T> {
  const out = new Map<number, keyof T>();
  for (const [key, code] of Object.entries(map)) out.set(code, key as keyof T);
  return out;
}

function lookupEnum<K>(table: Map<number, K>, code: number, label: string): K {
  const name = table.get(code);
  if (name === undefined) throw new Error(`unknown ${label} code: ${code}`);
  return name;
}

/** Decode the 7-tuple from `getEnforcementInputs` into typed `EnforcementInputs`. */
export function decodeEnforcementInputs(raw: RawEnforcementInputs): EnforcementInputs {
  return {
    status: lookupEnum<Status>(STATUS_BY_CODE, Number(raw.status), "status"),
    corroboration: Number(raw.corroboration),
    publisherRep: BigInt(raw.publisherRep),
    prominenceTier: Number(raw.prominenceTier),
    maturedAt: BigInt(raw.maturedAt),
    expiresAt: BigInt(raw.expiresAt),
    isSeeded: Boolean(raw.isSeeded),
  };
}

/**
 * Decode the `getAntibody` struct into a typed `Antibody`.
 *
 * `seed` stays `undefined` — the chain stores only the hash, never the matcher
 * inputs. The matchers verify-or-skip on a missing/mismatched seed, so a
 * chain-hydrated antibody simply waits for an S8 bootstrap to carry its seed.
 */
export function decodeAntibody(keccakId: Hex32, raw: RawAntibody): Antibody {
  const immSeq = Number(raw.immSeq);
  const createdAt = BigInt(raw.createdAt);
  return {
    keccakId,
    immSeq,
    immId: formatImmId(yearOf(createdAt), immSeq),
    abType: lookupEnum<AntibodyType>(ANTIBODY_TYPE_BY_CODE, Number(raw.abType), "abType"),
    flavor: Number(raw.flavor),
    verdict: lookupEnum<Verdict>(VERDICT_BY_CODE, Number(raw.verdict), "verdict"),
    status: lookupEnum<Status>(STATUS_BY_CODE, Number(raw.status), "status"),
    confidence: Number(raw.confidence),
    severity: Number(raw.severity),
    primaryMatcherHash: raw.primaryMatcherHash.toLowerCase() as Hex32,
    evidenceCid: raw.evidenceCid.toLowerCase() as Hex32,
    contextHash: raw.contextHash.toLowerCase() as Hex32,
    embeddingHash: raw.embeddingHash.toLowerCase() as Hex32,
    attestation: raw.attestation.toLowerCase() as Hex32,
    publisher: normalizeAddress(raw.publisher),
    reviewer: normalizeAddress(raw.reviewer),
    bondAmount: BigInt(raw.bondAmount),
    escrowedFees: BigInt(raw.escrowedFees),
    maturedAt: BigInt(raw.maturedAt),
    expiresAt: BigInt(raw.expiresAt),
    createdAt,
    isSeeded: Number(raw.isSeeded) !== 0,
    prominenceTier: Number(raw.prominenceTier),
    // seed intentionally omitted: the chain stores no matcher inputs, only the
    // hash. (exactOptionalPropertyTypes forbids an explicit `seed: undefined`.)
  };
}

/** UTC year of a Unix-seconds timestamp; the immId year segment is informational. */
function yearOf(unixSeconds: bigint): number {
  return new Date(Number(unixSeconds) * 1000).getUTCFullYear();
}
