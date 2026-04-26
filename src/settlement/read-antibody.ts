import type { Antibody, Hex32 } from "../types/antibody.js";
import { AntibodyNotFoundError } from "../types/errors.js";
import type { ChainAntibody } from "./decode.js";
import { decodeAntibody } from "./decode.js";
import type { RegistryClient } from "./registry-client.js";

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function getAntibody(registry: RegistryClient, keccakId: Hex32): Promise<Antibody> {
  const struct = (await registry.contract.getAntibody(keccakId)) as ChainAntibody;
  if (
    struct.publisher.toLowerCase() === ZERO_ADDRESS &&
    struct.primaryMatcherHash.toLowerCase() === ZERO_BYTES32
  ) {
    throw new AntibodyNotFoundError(keccakId);
  }
  return decodeAntibody(struct, keccakId);
}

export async function getAntibodyByImmSeq(
  registry: RegistryClient,
  immSeq: number,
): Promise<Antibody> {
  const struct = (await registry.contract.getAntibodyByImmSeq(immSeq)) as ChainAntibody;
  if (struct.publisher.toLowerCase() === ZERO_ADDRESS) {
    throw new AntibodyNotFoundError(immSeq);
  }
  // The contract does not return keccakId from this view; recompute it via
  // the pure helper to avoid an extra round-trip. The decoder lower-cases.
  const keccakId = (await registry.contract.computeKeccakId(
    Number(struct.abType),
    Number(struct.flavor),
    struct.primaryMatcherHash,
    struct.publisher,
  )) as Hex32;
  return decodeAntibody(struct, keccakId);
}
