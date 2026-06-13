import { Contract, type ContractRunner } from "ethers";
import ChallengeManagerAbi from "../abi/ChallengeManager.json" with { type: "json" };
import CREVerdictReceiverAbi from "../abi/CREVerdictReceiver.json" with { type: "json" };
import ImmunityRegistryAbi from "../abi/ImmunityRegistry.json" with { type: "json" };
import MockUSDCAbi from "../abi/MockUSDC.json" with { type: "json" };
import NovelVerificationAbi from "../abi/NovelVerification.json" with { type: "json" };
import ProtectedSetAbi from "../abi/ProtectedSet.json" with { type: "json" };
import PublisherRegistrarAbi from "../abi/PublisherRegistrar.json" with { type: "json" };
import ReputationAbi from "../abi/Reputation.json" with { type: "json" };
import type { Address } from "./types/antibody.js";
import type { NetworkConfig } from "./types/config.js";

/**
 * Typed ethers `Contract` factories bound to the deployed Base ABIs. These are
 * the SDK's low-level bindings to the live core network; higher layers (read
 * surface, settlement, enforcement) build on top of these.
 */
export const registryContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, ImmunityRegistryAbi, runner);

export const reputationContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, ReputationAbi, runner);

export const registrarContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, PublisherRegistrarAbi, runner);

export const protectedSetContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, ProtectedSetAbi, runner);

export const challengeManagerContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, ChallengeManagerAbi, runner);

export const creReceiverContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, CREVerdictReceiverAbi, runner);

export const novelVerificationContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, NovelVerificationAbi, runner);

export const usdcContract = (address: Address, runner: ContractRunner): Contract =>
  new Contract(address, MockUSDCAbi, runner);

/** All core contracts wired to a network config + runner, by name. */
export function coreContracts(net: NetworkConfig, runner: ContractRunner) {
  const a = net.addresses;
  return {
    registry: registryContract(a.registry, runner),
    reputation: reputationContract(a.reputation, runner),
    registrar: registrarContract(a.registrar, runner),
    protectedSet: protectedSetContract(a.protectedSet, runner),
    challengeManager: challengeManagerContract(a.challengeManager, runner),
    creReceiver: creReceiverContract(a.creReceiver, runner),
    novelVerification: novelVerificationContract(a.novelVerification, runner),
    usdc: usdcContract(a.usdc, runner),
  };
}

export type CoreContracts = ReturnType<typeof coreContracts>;
