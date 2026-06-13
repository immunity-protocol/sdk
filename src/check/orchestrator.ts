import type { MatchProbe } from "../matchers/matcher.js";
import type { EnforcementResolution } from "../registry/enforcement.js";
import type { RawVerdict } from "../tee/parse.js";
import { extractFacts } from "../tx/extractFacts.js";
import type { CheckOptions, CheckResult, NovelThreatPolicy } from "../types/check.js";
import type {
  ConfidenceThresholds,
  EscalateHandler,
  EscalationContext,
  ImmunityConfig,
  UnverifiedAntibodyPolicy,
} from "../types/config.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { createLogger } from "../util/logger.js";
import {
  type PolicyIntent,
  type TerminalDecision,
  planEnforcement,
  planFromVerdict,
} from "./policy.js";
import { type SettlementRegistry, selectSettleAntibodyId, settle } from "./settle.js";
import { type NovelVerifier, withTimeout } from "./verifier.js";

const log = createLogger("check");

const DEFAULT_THRESHOLDS: ConfidenceThresholds = { block: 85, escalate: 60 };

/** The effective, defaults-applied policy config the orchestrator runs against. */
export interface ResolvedCheckConfig {
  unverifiedAntibodyPolicy: UnverifiedAntibodyPolicy;
  novelThreatPolicy: NovelThreatPolicy;
  thresholds: ConfidenceThresholds;
  onTimeout: "deny" | "allow";
  onEscalate?: EscalateHandler | undefined;
  escalationTimeout?: number | undefined;
}

/** Apply S5 defaults to the raw SDK config: escalate / verify / 85·60 / deny. */
export function resolveCheckConfig(config: ImmunityConfig): ResolvedCheckConfig {
  return {
    unverifiedAntibodyPolicy: config.unverifiedAntibodyPolicy ?? "escalate",
    novelThreatPolicy: config.novelThreatPolicy ?? "verify",
    thresholds: {
      block: config.confidenceThresholds?.block ?? DEFAULT_THRESHOLDS.block,
      escalate: config.confidenceThresholds?.escalate ?? DEFAULT_THRESHOLDS.escalate,
    },
    onTimeout: config.onTimeout ?? "deny",
    onEscalate: config.onEscalate,
    escalationTimeout: config.escalationTimeout,
  };
}

export interface CheckDeps {
  resolver: { resolve(probe: MatchProbe): Promise<EnforcementResolution> };
  registry: SettlementRegistry;
  corroborationK: () => Promise<number>;
  config: ResolvedCheckConfig;
  verifier?: NovelVerifier | undefined;
  now?: (() => number) | undefined;
}

/**
 * The full `check()` orchestration for Tiers 1–2 + policies + mandatory
 * settlement. Resolves the enforcement tier (read-side), plans the policy
 * intent, executes any async effect (operator escalation / Tier-3 verify), then
 * ALWAYS settles the fee — the decision is independent of settlement.
 */
export async function runCheck(
  deps: CheckDeps,
  tx: ProposedTx | null,
  context: CheckContext,
  options?: CheckOptions,
): Promise<CheckResult> {
  const facts = extractFacts(tx);
  const resolution = await deps.resolver.resolve({ tx, context });

  const intent = planEnforcement(resolution, {
    unverifiedAntibodyPolicy: deps.config.unverifiedAntibodyPolicy,
    novelThreatPolicy: options?.policy ?? deps.config.novelThreatPolicy,
  });
  const terminal = await executeIntent(deps, intent, resolution, tx, context);

  // Mandatory fee — always settled, decision-independent. A revert is surfaced,
  // never allowed to flip the decision.
  const k = await deps.corroborationK();
  const nowSec = BigInt(Math.floor((deps.now ?? Date.now)() / 1000));
  const settleId = selectSettleAntibodyId(resolution, k, nowSec);
  const settlement = await settle(deps.registry, settleId, facts);

  return {
    allowed: terminal.decision === "allow",
    decision: terminal.decision,
    source: terminal.source,
    confidence: terminal.confidence,
    antibodies: resolution.antibodies,
    reason: settlement.note ? `${terminal.reason} [${settlement.note}]` : terminal.reason,
    checkId: settlement.checkId,
    novel: terminal.novel,
    txFacts: facts,
  };
}

async function executeIntent(
  deps: CheckDeps,
  intent: PolicyIntent,
  resolution: EnforcementResolution,
  tx: ProposedTx | null,
  context: CheckContext,
): Promise<TerminalDecision> {
  switch (intent.kind) {
    case "terminal":
      return intent;
    case "escalate":
      return runAdvisoryEscalation(deps, intent, resolution);
    case "verify":
      return runVerify(deps, { tx, context }, resolution, { novel: true, mode: "verify" });
    case "corroborate":
      return runVerify(deps, { tx, context }, resolution, { novel: false, mode: "corroborate" });
  }
}

/** Advisory `escalate` policy: consult the operator; fail-closed per onTimeout. */
async function runAdvisoryEscalation(
  deps: CheckDeps,
  intent: { source: TerminalDecision["source"]; confidence: number; reason: string },
  resolution: EnforcementResolution,
): Promise<TerminalDecision> {
  const ctx = escalationContext(resolution, intent.reason, intent.confidence);
  return consultOperator(deps, ctx, {
    source: intent.source,
    confidence: intent.confidence,
    novel: false,
    // Operator absent/throws/times out → onTimeout decides (may allow).
    onFailure: () =>
      deps.config.onTimeout === "allow"
        ? terminalOf(
            "allow",
            intent.source,
            intent.confidence,
            "advisory escalation failed open per onTimeout",
            false,
          )
        : terminalOf(
            "block",
            intent.source,
            intent.confidence,
            "advisory escalation failed closed",
            false,
          ),
  });
}

/** Tier-3 verify (novel `verify` / advisory `corroborate`). Fails CLOSED. */
async function runVerify(
  deps: CheckDeps,
  input: { tx: ProposedTx | null; context: CheckContext },
  resolution: EnforcementResolution,
  opts: { novel: boolean; mode: "verify" | "corroborate" },
): Promise<TerminalDecision> {
  if (!deps.verifier) {
    return failClosedVerify(deps, resolution, opts, "tier-3 verifier unavailable");
  }
  let verdict: RawVerdict;
  try {
    verdict = await withTimeout(
      deps.verifier.verify(input),
      deps.config.escalationTimeout,
      "verify",
    );
  } catch (err) {
    log.warn("tier-3 verify failed; failing closed", { message: errMessage(err) });
    return failClosedVerify(deps, resolution, opts, "tier-3 verifier failed");
  }

  const terminal = planFromVerdict(verdict, deps.config.thresholds, { novel: opts.novel });
  if (opts.mode === "verify" && terminal.decision === "block") {
    // TODO(S7): seed a new antibody for the confirmed novel threat.
    log.info("TODO(S7): seed antibody for confirmed novel threat", {
      confidence: verdict.confidence,
    });
  }
  if (opts.mode === "corroborate" && terminal.decision !== "allow") {
    // TODO(S7): publish a corroborating antibody if a registered publisher confirms.
    log.info("TODO(S7): publish corroborating antibody", { confidence: verdict.confidence });
  }
  return terminal;
}

/**
 * The stricter fail-closed rule for the Tier-3 path: `allow` may come ONLY from
 * an explicit operator allow, never from a timeout/fallback (novel +
 * checker-down = zero signal). `deny` → block outright; `allow` → surface to the
 * operator, but any operator failure still blocks.
 */
async function failClosedVerify(
  deps: CheckDeps,
  resolution: EnforcementResolution,
  opts: { novel: boolean },
  why: string,
): Promise<TerminalDecision> {
  if (deps.config.onTimeout !== "allow") {
    return terminalOf("block", "policy", 0, `${why}; failed closed`, opts.novel);
  }
  const ctx = escalationContext(resolution, why, 0);
  return consultOperator(deps, ctx, {
    source: "policy",
    confidence: 0,
    novel: opts.novel,
    // No operator allow → block. Never allow on a fallback for the Tier-3 path.
    onFailure: () => terminalOf("block", "policy", 0, `${why}; failed closed`, opts.novel),
  });
}

/**
 * Invoke `onEscalate` (with timeout) and map the result. `true` → allow,
 * `false` → block; absent/throws/times out → `opts.onFailure()`. Allow is
 * produced ONLY by an explicit `true`.
 */
async function consultOperator(
  deps: CheckDeps,
  ctx: EscalationContext,
  opts: {
    source: TerminalDecision["source"];
    confidence: number;
    novel: boolean;
    onFailure: () => TerminalDecision;
  },
): Promise<TerminalDecision> {
  if (!deps.config.onEscalate) return opts.onFailure();
  try {
    const allowed = await withTimeout(
      deps.config.onEscalate(ctx),
      deps.config.escalationTimeout,
      "escalate",
    );
    return allowed
      ? terminalOf(
          "allow",
          opts.source,
          opts.confidence,
          `${ctx.reason}: operator allowed`,
          opts.novel,
        )
      : terminalOf(
          "block",
          opts.source,
          opts.confidence,
          `${ctx.reason}: operator blocked`,
          opts.novel,
        );
  } catch (err) {
    log.warn("operator escalation failed; failing closed", { message: errMessage(err) });
    return opts.onFailure();
  }
}

function escalationContext(
  resolution: EnforcementResolution,
  reason: string,
  confidence: number,
): EscalationContext {
  return {
    reason,
    confidence,
    matched: resolution.antibodies.map((a) => ({ keccakId: a.keccakId, immId: a.immId })),
  };
}

function terminalOf(
  decision: TerminalDecision["decision"],
  source: TerminalDecision["source"],
  confidence: number,
  reason: string,
  novel: boolean,
): TerminalDecision {
  return { decision, source, confidence, reason, novel };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
