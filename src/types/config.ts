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
  /**
   * Pluggable novel-threat verifier. When provided, this function replaces
   * the default 0G Compute TEE broker used on `start()`. Same callable
   * shape, same outcome (`TeeVerifyOutcome`); the SDK calls it from
   * `check-flow.ts` whenever `novelThreatPolicy === "verify"` and the
   * cache + registry layers don't match. Useful when:
   *   - An agent's wallet can't fund the 0G Compute ledger's 3 OG floor
   *     and a hosted LLM (Claude, OpenAI) is available instead.
   *   - Tests want a deterministic stub.
   *   - Production wants to gate inference on a private model gateway.
   * The integrity guarantees of the 0G TEE (signed inference, attestation)
   * are NOT replicated by alternative backends. Use with that in mind.
   */
  teeVerifier?: import("../check-flow.js").TeeVerifyFn;
  /**
   * Antibody keccak ids the operator wants the local agent to mute, even
   * when the on-chain Registry still flags them ACTIVE. Used to retire a
   * bad auto-mint when the chain-side `slash` isn't reachable (deployed
   * Registry's slash is owner-only). Affects both Tier-1 cache hits and
   * Tier-2 chain-lookup hits — neither path returns a block decision for
   * a denylisted keccak. Local-only: each agent applies the filter
   * independently.
   */
  denyKeccakIds?: ReadonlyArray<`0x${string}`>;
  /**
   * Allow the TEE verifier to mint SEMANTIC antibodies from verdicts
   * (using the LLM-extracted marker, validated for length, multi-word
   * shape, denylist membership, and verbatim presence in the bundle).
   * Off by default. When false, SEMANTIC verdicts fall back to ADDRESS
   * seeds (the v0.4 behavior). See `seed-from-tx.ts` for guardrails.
   */
  semanticAutoMint?: boolean;
  /**
   * On `start()`, hydrate the local cache from the on-chain Registry by
   * iterating `getAntibodyByImmSeq(1..nextImmSeq)`. Default `true` so
   * late-joining peers see the catalog before their first check. Set to
   * `false` for one-shot scripts (publish-threats, fund-og) that do not
   * need to match on the catalog.
   */
  bootstrapCacheOnStart?: boolean;
  /**
   * Tuning for the bootstrap step (only relevant when
   * `bootstrapCacheOnStart` is true).
   */
  bootstrap?: {
    /** Concurrent fetches; default 4. */
    concurrency?: number;
    /** Soft cap on antibodies fetched. Default: no cap. */
    limit?: number;
    /**
     * Per-call retry budget for transient RPC errors (0.6.1+). Default 3.
     */
    fetchRetries?: number;
  };
  /**
   * Minimum 0G to keep in the TEE Compute ledger when the verifier inits.
   * Default 3. Lower values let agents with small wallets (e.g. demo fleet
   * agents holding ~0.3 OG) reach a working TEE without per-agent funding
   * topups.
   */
  minLedgerOg?: number;
  /**
   * Minimum 0G to deposit into the TEE provider sub-account when the
   * verifier inits. Default 1. Same rationale as `minLedgerOg`.
   */
  minProviderOg?: number;
}
