import type { EnforcementResolution } from "../registry/enforcement.js";
import { type RawVerdict, decideFromVerdict } from "../tee/parse.js";
import type { Antibody } from "../types/antibody.js";
import type { Decision, DecisionSource, NovelThreatPolicy } from "../types/check.js";
import type { ConfidenceThresholds, UnverifiedAntibodyPolicy } from "../types/config.js";

/**
 * A fully-decided outcome: nothing async left to do. The orchestrator copies
 * these fields straight into the `CheckResult`.
 */
export interface TerminalDecision {
  decision: Decision;
  source: DecisionSource;
  confidence: number;
  reason: string;
  novel: boolean;
}

/**
 * What the read-side tier + consumer policy demand, as a pure intent. `terminal`
 * needs no I/O; `escalate`/`verify`/`corroborate` require the orchestrator to
 * await an async effect (the operator handler or the Tier-3 verifier) and then
 * re-enter the pure layer via {@link planFromVerdict}.
 */
export type PolicyIntent =
  | ({ kind: "terminal" } & TerminalDecision)
  | { kind: "escalate"; source: DecisionSource; confidence: number; reason: string }
  | { kind: "verify"; reason: string }
  | { kind: "corroborate"; reason: string };

/** Highest confidence among matched antibodies; 0 for an empty set. */
export function maxConfidence(antibodies: Antibody[]): number {
  return antibodies.reduce((m, a) => Math.max(m, a.confidence), 0);
}

/**
 * Narrow a resolver source to a `CheckResult` source. A matched tier
 * (hard-block/advisory) always carries `cache` or `registry`; `none` only
 * accompanies tier `none`, so the fallback is defensive.
 */
function sourceOf(source: EnforcementResolution["source"]): DecisionSource {
  return source === "none" ? "policy" : source;
}

/**
 * Map a resolved enforcement tier + the consumer policies to an intent, per the
 * S5 decision matrix. Pure: no chain, no async, no I/O. The enforcement
 * decision is taken from the resolver's tier — never re-derived here.
 */
export function planEnforcement(
  resolution: EnforcementResolution,
  policies: {
    unverifiedAntibodyPolicy: UnverifiedAntibodyPolicy;
    novelThreatPolicy: NovelThreatPolicy;
  },
): PolicyIntent {
  const confidence = maxConfidence(resolution.antibodies);

  if (resolution.tier === "hard-block") {
    return {
      kind: "terminal",
      decision: "block",
      source: sourceOf(resolution.source),
      confidence,
      reason: "hard-block: corroborated or seeded antibody",
      novel: false,
    };
  }

  if (resolution.tier === "advisory") {
    switch (policies.unverifiedAntibodyPolicy) {
      case "ignore":
        return {
          kind: "terminal",
          decision: "allow",
          source: sourceOf(resolution.source),
          confidence,
          reason: "advisory antibody ignored by policy (fee still charged)",
          novel: false,
        };
      case "block":
        return {
          kind: "terminal",
          decision: "block",
          source: sourceOf(resolution.source),
          confidence,
          reason: "advisory antibody blocked by policy",
          novel: false,
        };
      case "escalate":
        return {
          kind: "escalate",
          source: sourceOf(resolution.source),
          confidence,
          reason: "advisory antibody escalated to operator",
        };
      case "corroborate":
        return { kind: "corroborate", reason: "advisory antibody re-verified for corroboration" };
    }
  }

  // tier === "none" → novel input.
  switch (policies.novelThreatPolicy) {
    case "trust-cache":
      return {
        kind: "terminal",
        decision: "allow",
        source: "policy",
        confidence: 0,
        reason: "novel input trusted by policy",
        novel: true,
      };
    case "deny-novel":
      return {
        kind: "terminal",
        decision: "block",
        source: "policy",
        confidence: 0,
        reason: "novel input denied by policy",
        novel: false,
      };
    case "verify":
      return { kind: "verify", reason: "novel input — verifying via tier-3" };
  }
}

/**
 * Map a fresh Tier-3 verdict to a terminal decision via the confidence
 * thresholds. Pure — wraps {@link decideFromVerdict}. A verdict in the escalate
 * band yields `decision: "escalate"` (the caller surfaces it out-of-band); it
 * does NOT re-invoke the operator handler here.
 */
export function planFromVerdict(
  verdict: RawVerdict,
  thresholds: ConfidenceThresholds,
  ctx: { novel: boolean },
): TerminalDecision {
  const d = decideFromVerdict(verdict, thresholds.block, thresholds.escalate);
  const base = {
    source: "tee" as const,
    confidence: verdict.confidence,
    novel: ctx.novel,
  };
  if (d.treatAsBlock) {
    return {
      ...base,
      decision: "block",
      reason: `tee verdict: ${verdict.verdict} (confidence ${verdict.confidence})`,
    };
  }
  if (d.treatAsEscalate) {
    return {
      ...base,
      decision: "escalate",
      reason: `tee verdict: ${verdict.verdict} (confidence ${verdict.confidence}) — below block threshold`,
    };
  }
  return {
    ...base,
    decision: "allow",
    reason: `tee verdict: ${verdict.verdict} (confidence ${verdict.confidence})`,
  };
}
