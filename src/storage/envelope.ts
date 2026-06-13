import type { Address, AntibodyType, Hex32 } from "../types/antibody.js";

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

// TODO(storage-lighthouse): the envelope SCHEMA is kept (consumed by the
// explorer/read surface). The upload/fetch transport is rebuilt on Lighthouse
// (@lighthouse-web3/sdk + the network's `lighthouseGateway`) in the storage
// package — the old 0G StorageClient transport was removed in S0.
export async function uploadPublicEnvelope(
  _envelope: PublicEnvelopeV1,
): Promise<{ evidenceCid: Hex32; txHash: string }> {
  throw new Error("not implemented in v1 yet (storage-lighthouse package)");
}

export async function fetchPublicEnvelope(_cid: Hex32): Promise<PublicEnvelopeV1> {
  throw new Error("not implemented in v1 yet (storage-lighthouse package)");
}
