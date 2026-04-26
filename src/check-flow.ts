import type { AntibodyCache } from "./cache/cache.js";
import type { GossipPublisher } from "./gossip/publisher.js";
import type { MatcherRegistry } from "./matchers/matcher.js";
import { settleCheck } from "./settlement/check.js";
import { publish as publishAntibody } from "./settlement/publish.js";
import type { RegistryClient } from "./settlement/registry-client.js";
import type { Address, Antibody, AntibodySeed, Hex32 } from "./types/antibody.js";
import type { CheckOptions, CheckResult, NovelThreatPolicy } from "./types/check.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { EscalationError } from "./types/errors.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("immunity:check");

export interface CheckFlowDeps {
  wallet: Address;
  registry: RegistryClient;
  cache: AntibodyCache;
  matchers: MatcherRegistry;
  publisher: GossipPublisher;
  defaultChainId: number;
  policy: NovelThreatPolicy;
  onEscalate?: (ctx: {
    reason: string;
    confidence: number;
    matched: { keccakId: string; immId: string }[];
  }) => Promise<boolean>;
  /**
   * Hook invoked after a TEE verdict says block: builds the seed for the
   * auto-publish step. Pluggable so the Immunity facade can wire it to
   * the TEE module without dragging the whole `tee/` subtree into this
   * file (the facade may not have TEE configured at all).
   */
  teeVerify?: (tx: ProposedTx | null, ctx: CheckContext) => Promise<TeeVerifyOutcome | null>;
}

export interface TeeVerifyOutcome {
  block: boolean;
  escalate: boolean;
  reason: string;
  confidence: number;
  severity: number;
  /** Seed for the auto-publish step; only ADDRESS / CALL_PATTERN supported in v1. */
  publishSeed?: AntibodySeed;
}

export async function runCheck(
  tx: ProposedTx | null,
  context: CheckContext,
  options: CheckOptions | undefined,
  deps: CheckFlowDeps,
): Promise<CheckResult> {
  const policy = options?.policy ?? deps.policy;

  if (!tx && isContextEmpty(context)) {
    log.debug("short-circuit allow: no actionable input");
    return result("allow", null, [], "no actionable input", "policy", 0, false);
  }

  const hit = await deps.matchers.matchFirst({ tx, context });
  if (hit) {
    const settlement = await settleCheck(deps.registry, hit.antibody.keccakId);
    return result(
      "block",
      settlement.txHash,
      [hit.antibody],
      hit.reason,
      "cache",
      hit.antibody.confidence,
      false,
    );
  }

  if (policy === "deny-novel") {
    const settlement = await settleCheck(deps.registry, null);
    return result(
      "block",
      settlement.txHash,
      [],
      "deny-novel policy: no cached match",
      "policy",
      0,
      false,
    );
  }

  if (policy === "trust-cache" || !deps.teeVerify) {
    const settlement = await settleCheck(deps.registry, null);
    const reason =
      policy === "trust-cache"
        ? "trust-cache policy: novel input allowed without verification"
        : "verify policy requested but TEE not configured; allowing (novel)";
    if (!deps.teeVerify) log.warn(reason);
    return result("allow", settlement.txHash, [], reason, "policy", 0, true);
  }

  // verify mode: ask the TEE
  const verdict = await deps.teeVerify(tx, context);
  if (!verdict || (!verdict.block && !verdict.escalate)) {
    const settlement = await settleCheck(deps.registry, null);
    return result(
      "allow",
      settlement.txHash,
      [],
      verdict?.reason ?? "TEE verdict benign",
      "tee",
      verdict?.confidence ?? 0,
      false,
    );
  }

  if (verdict.block && verdict.publishSeed) {
    let mintedAntibody: Antibody | null = null;
    try {
      const pub = await publishAntibody(deps.registry, deps.wallet, {
        seed: verdict.publishSeed,
        verdict: "MALICIOUS",
        confidence: verdict.confidence,
        severity: verdict.severity,
      });
      const minted: Antibody = synthAntibodyFor(pub.keccakId, pub.immSeq, deps.wallet, verdict);
      deps.cache.put(minted);
      await deps.publisher.announce(minted).catch((e) => log.warn("gossip announce failed", e));
      mintedAntibody = minted;
    } catch (err) {
      log.warn("auto-publish failed; continuing as block-only", err);
    }
    const settlement = await settleCheck(deps.registry, mintedAntibody?.keccakId ?? null);
    return result(
      "block",
      settlement.txHash,
      mintedAntibody ? [mintedAntibody] : [],
      verdict.reason,
      "tee",
      verdict.confidence,
      false,
    );
  }

  // escalate path
  const allowed = await runEscalate(deps, verdict);
  const settlement = await settleCheck(deps.registry, null);
  return result(
    allowed ? "allow" : "block",
    settlement.txHash,
    [],
    `${verdict.reason} (operator ${allowed ? "allowed" : "blocked"})`,
    "tee",
    verdict.confidence,
    false,
  );
}

async function runEscalate(deps: CheckFlowDeps, verdict: TeeVerifyOutcome): Promise<boolean> {
  if (!deps.onEscalate) throw new EscalationError("no-handler");
  return deps.onEscalate({
    reason: verdict.reason,
    confidence: verdict.confidence,
    matched: [],
  });
}

function isContextEmpty(ctx: CheckContext): boolean {
  return (
    !ctx.conversation?.length &&
    !ctx.toolTrace?.length &&
    !ctx.sources?.length &&
    !ctx.counterparty &&
    !ctx.metadata
  );
}

function result(
  decision: "allow" | "block" | "escalate",
  checkId: Hex32 | null,
  antibodies: Antibody[],
  reason: string,
  source: "cache" | "tee" | "policy",
  confidence: number,
  novel: boolean,
): CheckResult {
  return {
    allowed: decision === "allow",
    decision,
    source,
    confidence,
    antibodies,
    reason,
    checkId,
    novel,
  };
}

function synthAntibodyFor(
  keccakId: Hex32,
  immSeq: number,
  publisher: Address,
  v: TeeVerifyOutcome,
): Antibody {
  const seed = v.publishSeed;
  if (!seed) throw new Error("expected publishSeed");
  return {
    keccakId,
    immSeq,
    immId: `IMM-${new Date().getUTCFullYear()}-${String(immSeq).padStart(4, "0")}`,
    abType: seed.abType,
    flavor: seed.abType === "SEMANTIC" ? semanticFlavorCode(seed.flavor) : 0,
    verdict: "MALICIOUS",
    status: "ACTIVE",
    confidence: v.confidence,
    severity: v.severity,
    primaryMatcherHash: keccakId,
    evidenceCid: ZERO_BYTES32,
    contextHash: ZERO_BYTES32,
    embeddingHash: ZERO_BYTES32,
    attestation: ZERO_BYTES32,
    publisher,
    reviewer: publisher,
    stakeAmount: 1_000_000n,
    stakeLockUntil: 0n,
    expiresAt: 0n,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    isSeeded: false,
    seed,
  };
}

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

function semanticFlavorCode(flavor: "COUNTERPARTY" | "MANIPULATION" | "PROMPT_INJECTION"): number {
  return flavor === "COUNTERPARTY" ? 0 : flavor === "MANIPULATION" ? 1 : 2;
}
