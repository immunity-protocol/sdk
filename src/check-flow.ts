import type { AntibodyCache } from "./cache/cache.js";
import type { GossipPublisher } from "./gossip/publisher.js";
import type { MatcherRegistry } from "./matchers/matcher.js";
import type { Tier2LookupClient } from "./registry/lookup.js";
import { settleCheck } from "./settlement/check.js";
import { publish as publishAntibody } from "./settlement/publish.js";
import type { RegistryClient } from "./settlement/registry-client.js";
import type { StorageClient } from "./storage/indexer.js";
import { type TxFacts, extractFacts } from "./tx/extractFacts.js";
import type { Address, Antibody, AntibodySeed, Hex32 } from "./types/antibody.js";
import type { CheckOptions, CheckResult, NovelThreatPolicy } from "./types/check.js";
import type { CheckContext, ProposedTx } from "./types/context.js";
import { EscalationError } from "./types/errors.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("immunity:check");

export interface CheckFlowDeps {
  wallet: Address;
  registry: RegistryClient;
  storage: StorageClient;
  cache: AntibodyCache;
  matchers: MatcherRegistry;
  publisher: GossipPublisher;
  defaultChainId: number;
  policy: NovelThreatPolicy;
  /**
   * Tier-2 lookup against the on-chain Registry's matcher index. Optional
   * for tests and degraded modes; when absent, `check()` skips Tier 2 and
   * goes straight from cache miss to policy fork (the legacy two-tier path).
   */
  lookup?: Tier2LookupClient;
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
  // Extracted once at the top so every return path carries the same facts.
  const txFacts = extractFacts(tx);

  if (!tx && isContextEmpty(context)) {
    log.debug("short-circuit allow: no actionable input");
    return result("allow", null, [], "no actionable input", "policy", 0, false, txFacts);
  }

  const hit = await deps.matchers.matchFirst({ tx, context });
  if (hit) {
    const settlement = await settleCheck(deps.registry, hit.antibody.keccakId, txFacts);
    return result(
      "block",
      settlement.txHash,
      [hit.antibody],
      hit.reason,
      "cache",
      hit.antibody.confidence,
      false,
      txFacts,
    );
  }

  // Tier 2: chain has the canonical record even when the cache missed. Going
  // through the Registry's matcher index avoids burning a TEE call for any
  // threat that's already known to the network. Populate Tier 1 on hit so
  // the next check() this process serves resolves locally.
  if (deps.lookup) {
    const onChain = await deps.lookup.firstMatch(tx, context);
    if (onChain) {
      deps.cache.put(onChain);
      const settlement = await settleCheck(deps.registry, onChain.keccakId, txFacts);
      return result(
        "block",
        settlement.txHash,
        [onChain],
        "Registry matcher index hit",
        "registry",
        onChain.confidence,
        false,
        txFacts,
      );
    }
  }

  if (policy === "deny-novel") {
    const settlement = await settleCheck(deps.registry, null, txFacts);
    return result(
      "block",
      settlement.txHash,
      [],
      "deny-novel policy: no cached match",
      "policy",
      0,
      false,
      txFacts,
    );
  }

  if (policy === "trust-cache" || !deps.teeVerify) {
    const settlement = await settleCheck(deps.registry, null, txFacts);
    const reason =
      policy === "trust-cache"
        ? "trust-cache policy: novel input allowed without verification"
        : "verify policy requested but TEE not configured; allowing (novel)";
    if (!deps.teeVerify) log.warn(reason);
    return result("allow", settlement.txHash, [], reason, "policy", 0, true, txFacts);
  }

  // verify mode: ask the TEE
  const verdict = await deps.teeVerify(tx, context);
  if (!verdict || (!verdict.block && !verdict.escalate)) {
    const settlement = await settleCheck(deps.registry, null, txFacts);
    return result(
      "allow",
      settlement.txHash,
      [],
      verdict?.reason ?? "TEE verdict benign",
      "tee",
      verdict?.confidence ?? 0,
      false,
      txFacts,
    );
  }

  if (verdict.block && verdict.publishSeed) {
    const minted = await mintAndAnnounce(deps, verdict);
    const settlement = await settleCheck(deps.registry, minted?.keccakId ?? null, txFacts);
    return result(
      "block",
      settlement.txHash,
      minted ? [minted] : [],
      verdict.reason,
      "tee",
      verdict.confidence,
      false,
      txFacts,
    );
  }

  // escalate path
  const allowed = await runEscalate(deps, verdict);
  // Operator-confirmed threat: when the operator denies the action AND the
  // verifier produced a derivable seed, mint+gossip the antibody. The
  // operator's deny is the consent signal that this matcher belongs on the
  // network; without it we'd be flooding the network with low-confidence
  // antibodies. With it, escalate-deny becomes a quality-gated publish.
  const minted = !allowed && verdict.publishSeed ? await mintAndAnnounce(deps, verdict) : null;
  const settlement = await settleCheck(deps.registry, minted?.keccakId ?? null, txFacts);
  return result(
    allowed ? "allow" : "block",
    settlement.txHash,
    minted ? [minted] : [],
    `${verdict.reason} (operator ${allowed ? "allowed" : "blocked"})`,
    "tee",
    verdict.confidence,
    false,
    txFacts,
  );
}

async function mintAndAnnounce(
  deps: CheckFlowDeps,
  verdict: TeeVerifyOutcome,
): Promise<Antibody | null> {
  if (!verdict.publishSeed) return null;
  try {
    const pub = await publishAntibody(deps.registry, deps.storage, deps.wallet, {
      seed: verdict.publishSeed,
      verdict: "MALICIOUS",
      confidence: verdict.confidence,
      severity: verdict.severity,
      // The TEE produces a free-text reason; surface it as the public
      // envelope's reasonSummary so peers see why the antibody was minted.
      reasonSummary: verdict.reason,
    });
    const minted = synthAntibodyFor(pub.keccakId, pub.immSeq, deps.wallet, verdict);
    deps.cache.put(minted);
    await deps.publisher.announce(minted).catch((e) => log.warn("gossip announce failed", e));
    return minted;
  } catch (err) {
    log.warn("auto-publish failed; continuing without antibody", err);
    return null;
  }
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
  source: "cache" | "registry" | "tee" | "policy",
  confidence: number,
  novel: boolean,
  txFacts: TxFacts,
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
    txFacts,
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
