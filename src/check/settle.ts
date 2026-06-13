import { classifyEnforcement, type EnforcementResolution, type EnforcementTier } from "../registry/enforcement.js";
import type { TxFacts } from "../tx/extractFacts.js";
import type { Hex32 } from "../types/antibody.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("settlement");

/** `bytes32(0)` — the settlement id for a novel / no-match check. */
export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex32;

// Local tier ranking, mirroring the resolver's. Strongest wins.
const TIER_RANK: Record<EnforcementTier, number> = { none: 0, advisory: 1, "hard-block": 2 };

/**
 * The antibody whose fee this check settles: the strongest-tier matched
 * antibody, tiebroken by lowest `immSeq` (the earliest publisher). Re-derives
 * each antibody's tier from its enforcement inputs — the resolution carries one
 * aggregate tier but a set of antibodies. Returns `bytes32(0)` for a novel or
 * no-match check (the full fee then funds the treasury / novel compute).
 *
 * Known v1 simplification: a corroborated hit pays exactly one of the K
 * publishers (the earliest), not a split.
 */
export function selectSettleAntibodyId(
  resolution: EnforcementResolution,
  k: number,
  nowSec: bigint,
): Hex32 {
  const { antibodies, inputs } = resolution;
  if (resolution.tier === "none" || antibodies.length === 0) return ZERO_BYTES32;
  // Defensive: the resolver pushes antibodies and inputs in lockstep.
  if (inputs.length !== antibodies.length) return antibodies[0]?.keccakId ?? ZERO_BYTES32;

  let best: { id: Hex32; rank: number; immSeq: number } | null = null;
  for (let i = 0; i < antibodies.length; i++) {
    const ab = antibodies[i];
    const inp = inputs[i];
    if (!ab || !inp) continue;
    const rank = TIER_RANK[classifyEnforcement(inp, k, nowSec)];
    if (!best || rank > best.rank || (rank === best.rank && ab.immSeq < best.immSeq)) {
      best = { id: ab.keccakId, rank, immSeq: ab.immSeq };
    }
  }
  return best?.id ?? ZERO_BYTES32;
}

/** The single write method S5 calls — the mandatory on-chain fee settlement. */
export interface SettlementRegistry {
  check(
    antibodyId: Hex32,
    tokenAddress: string,
    tokenAmount: bigint,
    originChainId: number,
  ): Promise<{ hash: string }>;
}

export interface SettlementResult {
  /** The settlement tx hash, or `null` when the on-chain call reverted. */
  checkId: Hex32 | null;
  /** A human-readable note when settlement did NOT record (else undefined). */
  note?: string;
}

/**
 * Submit the mandatory fee settlement. The protective decision is INDEPENDENT
 * of this call — we do not `.wait()` for confirmation, and a revert (e.g. an
 * unfunded balance) is surfaced as `checkId: null` + a note, never rethrown and
 * never allowed to flip a block to an allow.
 */
export async function settle(
  registry: SettlementRegistry,
  antibodyId: Hex32,
  facts: TxFacts,
): Promise<SettlementResult> {
  try {
    const tx = await registry.check(antibodyId, facts.tokenAddress, facts.tokenAmount, facts.originChainId);
    return { checkId: tx.hash as Hex32 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("settlement reverted; decision stands", { antibodyId, message });
    return { checkId: null, note: `settlement not recorded: ${message}` };
  }
}
