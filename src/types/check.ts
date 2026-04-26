import type { Antibody, Hex32 } from "./antibody.js";

/**
 * Decision classes returned by `check()`.
 *
 * - `allow`: caller may proceed.
 * - `block`: caller must abort. A matched antibody is included.
 * - `escalate`: caller must wait for an out-of-band operator decision via
 *   the configured `onEscalate` handler.
 */
export type Decision = "allow" | "block" | "escalate";

/**
 * Source of the verdict producing a result.
 *
 * - `cache`: a local matcher hit on a cached antibody.
 * - `tee`: a 0G Compute TEE inference returned a verdict for a novel input.
 * - `policy`: no matcher hit and no TEE call; the configured policy decided.
 */
export type DecisionSource = "cache" | "tee" | "policy";

export interface CheckResult {
  allowed: boolean;
  decision: Decision;
  source: DecisionSource;
  confidence: number;
  antibodies: Antibody[];
  reason: string;
  /** Settlement transaction hash on 0G Chain, or `null` when no on-chain call was made. */
  checkId: Hex32 | null;
  /** True when an `allow` result came from cache miss with no TEE verification. */
  novel: boolean;
}

export interface CheckOptions {
  /**
   * Override `novelThreatPolicy` for this single call. Useful for letting
   * a high-stakes action force `verify` even when the SDK is configured
   * for `trust-cache`.
   */
  policy?: NovelThreatPolicy;
}

/**
 * What `check()` does on a cache miss.
 *
 * - `verify`: call the 0G Compute TEE to assess novel inputs (default).
 * - `trust-cache`: allow novel inputs, set `CheckResult.novel = true` so
 *   operators can audit. Cost-vs-coverage tradeoff.
 * - `deny-novel`: block novel inputs unconditionally. Strictest mode.
 */
export type NovelThreatPolicy = "verify" | "trust-cache" | "deny-novel";
