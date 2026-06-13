import type { Signer } from "ethers";
import type { Address } from "./antibody.js";
import type { NovelThreatPolicy } from "./check.js";

/**
 * Built-in network presets. `custom` is for self-hosted or future networks.
 */
export type NetworkPreset = "base-sepolia" | "base-mainnet" | "custom";

/** The deployed Immunity core contract addresses for a network. */
export interface CoreAddresses {
  registry: Address;
  reputation: Address;
  registrar: Address;
  protectedSet: Address;
  challengeManager: Address;
  creReceiver: Address;
  usdc: Address;
  l2registry: Address;
}

/**
 * Canonical per-network configuration. Every consumer of network state reads
 * from this object — no hardcoded constants elsewhere in the SDK. Extend this
 * type rather than scattering new constants.
 */
export interface NetworkConfig {
  /** Human-readable identifier, e.g. "base-sepolia". */
  name: string;
  chainId: number;
  rpcUrl: string;
  /** Block explorer base URL (no trailing slash). */
  blockExplorerUrl: string;
  /** Lighthouse IPFS gateway base (with trailing slash), e.g. ".../ipfs/". */
  lighthouseGateway: string;
  /** Deployed Immunity core contract addresses. */
  addresses: CoreAddresses;
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
 * How a consumer treats an antibody that is NOT yet hard-block-eligible
 * (i.e. `corroboration < K` and not genesis-seeded) — the read-side policy
 * knob. Behavior is wired in a later package.
 *   - ignore:      treat advisory antibodies as no-ops (don't even pay a fee)
 *   - escalate:    surface to `onEscalate` for an operator decision
 *   - block:       act on advisory antibodies as if hard-block
 *   - corroborate: publish a corroborating antibody to strengthen the signal
 */
export type UnverifiedAntibodyPolicy = "ignore" | "escalate" | "block" | "corroborate";

/**
 * Top-level Immunity SDK configuration.
 */
export interface ImmunityConfig {
  wallet: Signer;
  network?: NetworkPreset | NetworkConfig;
  onEscalate?: EscalateHandler;
  escalationTimeout?: number;
  onTimeout?: "deny" | "allow";
  confidenceThresholds?: Partial<ConfidenceThresholds>;
  /** Policy for genuinely novel threats (no cache/registry match). */
  novelThreatPolicy?: NovelThreatPolicy;
  /** Read-side policy for not-yet-hard-block-eligible (advisory) antibodies. */
  unverifiedAntibodyPolicy?: UnverifiedAntibodyPolicy;
  /**
   * Antibody keccak ids the operator wants the local agent to mute, even
   * when the on-chain Registry still flags them. Local-only filter applied
   * to both Tier-1 cache hits and Tier-2 chain-lookup hits.
   */
  denyKeccakIds?: ReadonlyArray<`0x${string}`>;
  /**
   * On `start()`, hydrate the local cache from the on-chain Registry.
   * Default `true`. Set `false` for one-shot scripts.
   */
  bootstrapCacheOnStart?: boolean;
  /** Tuning for the bootstrap step (only when `bootstrapCacheOnStart`). */
  bootstrap?: {
    /** Concurrent fetches; default 4. */
    concurrency?: number;
    /** Soft cap on antibodies fetched. Default: no cap. */
    limit?: number;
    /** Per-call retry budget for transient RPC errors. Default 3. */
    fetchRetries?: number;
  };
}
