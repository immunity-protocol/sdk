import type { Signer } from "ethers";
import type { Address } from "./antibody.js";
import type { NovelThreatPolicy } from "./check.js";

/**
 * Built-in network presets. `custom` is for self-hosted or future networks.
 */
export type NetworkPreset = "testnet" | "custom";

export interface NetworkConfig {
  chainId: number;
  rpcUrl: string;
  registryAddress: Address;
  usdcAddress: Address;
  computeProvider?: Address;
  storageIndexerUrl?: string;
}

export interface ConfidenceThresholds {
  /** confidence >= block auto-blocks for MALICIOUS verdicts (default 85). */
  block: number;
  /** confidence >= escalate triggers `onEscalate` (default 60). */
  escalate: number;
}

/**
 * Operator decision returned from `onEscalate`. `true` allows the action,
 * `false` blocks it.
 */
export type EscalationDecision = boolean;

export interface EscalationContext {
  reason: string;
  confidence: number;
  matched: { keccakId: string; immId: string }[];
}

export type EscalateHandler = (ctx: EscalationContext) => Promise<EscalationDecision>;

/**
 * Top-level Immunity SDK configuration.
 *
 * `axlUrl` is required: the SDK refuses to start without an external AXL
 * endpoint. There is no in-process pubsub fallback by design.
 */
export interface ImmunityConfig {
  wallet: Signer;
  network?: NetworkPreset | NetworkConfig;
  axlUrl: string;
  axlIdentityPath?: string;
  onEscalate?: EscalateHandler;
  escalationTimeout?: number;
  onTimeout?: "deny" | "allow";
  confidenceThresholds?: Partial<ConfidenceThresholds>;
  novelThreatPolicy?: NovelThreatPolicy;
}
