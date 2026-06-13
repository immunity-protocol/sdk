// Typed structural bindings for the contract calls the seed script makes
// directly (outside the SDK write surface): deployer-side mint / reputation
// grant, and the read-side corroboration / enforcement / bond queries.
//
// Mirrors the SDK's own pattern (src/publish/operations.ts): a minimal
// interface per contract, satisfied by a real ethers `Contract` via a cast.

import type { ContractRunner } from "ethers";
import {
  type NetworkConfig,
  registrarContract,
  registryContract,
  reputationContract,
  usdcContract,
} from "../../src/index.js";

interface Tx {
  hash: string;
  wait(): Promise<unknown>;
}

export interface UsdcOps {
  mint(to: string, amount: bigint): Promise<Tx>;
  balanceOf(account: string): Promise<bigint>;
}

export interface ReputationOps {
  owner(): Promise<string>;
  scoreOf(account: string): Promise<bigint>;
  grantGenesisReputation(account: string, amount: bigint): Promise<Tx>;
}

/** Raw `getAntibody` fields the seed reads (named-tuple access on the ethers Result). */
export interface RawAntibodyView {
  publisher: string;
  evidenceCid: string;
  status: bigint | number;
}

/** Raw `getEnforcementInputs` tuple — structurally matches the SDK's decoder input. */
export interface RawEnforcementView {
  status: bigint | number;
  corroboration: bigint | number;
  publisherRep: bigint | number;
  prominenceTier: bigint | number;
  maturedAt: bigint | number;
  expiresAt: bigint | number;
  isSeeded: boolean;
}

export interface RegistryReadOps {
  computeBond(severity: number, target: string): Promise<bigint>;
  corroborationOf(matcherHash: string): Promise<bigint>;
  corroborationK(): Promise<bigint>;
  minCorroborationRep(): Promise<bigint>;
  getAntibody(keccakId: string): Promise<RawAntibodyView>;
  getEnforcementInputs(keccakId: string): Promise<RawEnforcementView>;
}

export interface RegistrarReadOps {
  registrationBond(): Promise<bigint>;
  isRegistered(account: string): Promise<boolean>;
}

export interface OnchainBindings {
  usdc: UsdcOps;
  reputation: ReputationOps;
  registry: RegistryReadOps;
  registrar: RegistrarReadOps;
}

/** Build the typed bindings against a signer (writes) or provider (reads). */
export function buildOnchain(net: NetworkConfig, runner: ContractRunner): OnchainBindings {
  return {
    usdc: usdcContract(net.addresses.usdc, runner) as unknown as UsdcOps,
    reputation: reputationContract(net.addresses.reputation, runner) as unknown as ReputationOps,
    registry: registryContract(net.addresses.registry, runner) as unknown as RegistryReadOps,
    registrar: registrarContract(net.addresses.registrar, runner) as unknown as RegistrarReadOps,
  };
}
