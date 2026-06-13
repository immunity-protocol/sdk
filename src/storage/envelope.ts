import type { Address, AntibodyType, Hex32 } from "../types/antibody.js";
import type { PutEvidenceResult, StorageClient } from "./client.js";
import type { EciesBundle } from "./crypto.js";

/**
 * Public envelope JSON uploaded to storage as `evidenceCid`. Consumers
 * (explorer, indexer, peer agents) hydrate richer detail from this without
 * touching the chain.
 *
 * Schema is the public surface of the antibody and intentionally redacts
 * the original context (which lives encrypted under `contextHash`).
 */
export interface PublicEnvelopeV1 {
  schema: "immunity/antibody-envelope/v1";
  keccakId: Hex32;
  immId: string;
  abType: AntibodyType;
  flavor: number;
  publisher: Address;
  createdAt: string;
  reasonSummary: string;
  attestation?: Hex32;
  matcher: PublicMatcherSummary;
}

export type PublicMatcherSummary =
  | { kind: "address"; chainId: number; target: Address }
  | { kind: "call_pattern"; chainId: number; target: Address; selector: string }
  | { kind: "bytecode"; bytecodeHash: Hex32 }
  | { kind: "graph"; chainId: number; taintSetId: Hex32; size: number }
  | { kind: "semantic"; flavor: string; markerHint?: string };

/**
 * The envelope SCHEMA above is the public, keyless-readable surface consumed by
 * the explorer/indexer/matchers. Transport is delegated to a `StorageClient`
 * (signed-POST WRITE / keyless IPFS READ): the SDK holds no Lighthouse key.
 */
export async function uploadPublicEnvelope(
  client: StorageClient,
  envelope: PublicEnvelopeV1,
  encryptedContext?: EciesBundle,
): Promise<PutEvidenceResult> {
  return client.putEvidence(envelope, encryptedContext);
}

export async function fetchPublicEnvelope(
  client: StorageClient,
  evidenceCid: Hex32,
): Promise<PublicEnvelopeV1> {
  return client.fetchPublicEnvelope(evidenceCid);
}
