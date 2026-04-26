import type { Address, AntibodyType, Hex32 } from "../types/antibody.js";
import type { StorageClient } from "./indexer.js";

/**
 * Public envelope JSON uploaded to 0G Storage as `evidenceCid`. Consumers
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

export async function uploadPublicEnvelope(
  storage: StorageClient,
  envelope: PublicEnvelopeV1,
): Promise<{ evidenceCid: Hex32; txHash: string }> {
  const { rootHash, txHash } = await storage.uploadJson(envelope);
  return { evidenceCid: rootHash, txHash };
}

export async function fetchPublicEnvelope(
  storage: StorageClient,
  cid: Hex32,
): Promise<PublicEnvelopeV1> {
  const raw = await storage.downloadJson<PublicEnvelopeV1>(cid);
  if (raw?.schema !== "immunity/antibody-envelope/v1") {
    throw new Error(`unexpected envelope schema: ${raw?.schema}`);
  }
  return raw;
}
