import type { Signer } from "ethers";
import type { Address } from "./antibody.js";
import type { NovelThreatPolicy } from "./check.js";

/**
 * Built-in network presets. `custom` is for self-hosted or future networks.
 */
export type NetworkPreset = "testnet" | "custom";

/**
 * Canonical per-network configuration. Every consumer of network state
 * (Registry/USDC addresses, RPC, storage indexer, compute provider, AXL hubs)
 * reads from this object — no hardcoded constants elsewhere in the SDK.
 *
 * All fields required so a redeploy is a single-file change. Extend this
 * type rather than scattering new constants.
 */
export interface NetworkConfig {
  /** Human-readable identifier, e.g. "galileo-testnet". */
  name: string;
  chainId: number;
  rpcUrl: string;
  registryAddress: Address;
  usdcAddress: Address;
  /** Block explorer base URL (no trailing slash). */
  blockExplorerUrl: string;
  /** 0G Storage indexer used for envelope upload/download. */
  storageIndexerUrl: string;
  /** 0G Compute provider address that hosts the TEE inference model. */
  computeProvider: Address;
  /** TEE model identifier, e.g. "qwen-2.5-7b-instruct". */
  computeModel: string;
  /** AXL pubsub hub URIs the SDK can connect to (the gossip mesh). */
  axlHubs: string[];
  /** Mainnet RPC used for ENS reverse resolution of publisher addresses. */
  ensRpcUrl: string;
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
