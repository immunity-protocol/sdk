import type { AntibodySeed } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { isAddress, normalizeAddress } from "../util/address.js";
import type { RawVerdict } from "./parse.js";

/**
 * Deterministic mapping from a TEE verdict to an AntibodySeed using ONLY
 * observable facts (proposed tx fields, counterparty id). Never reads
 * free-text from `verdict.reasoning` to choose a target.
 *
 * The injection-defense contract: an attacker who controls the encrypted
 * context bundle cannot influence which address or pattern the resulting
 * antibody flags, because this function never trusts the bundle's content.
 * The LLM only labels (verdict, abType, confidence); the SDK names the
 * target from the proposal that triggered the check.
 *
 * Returns `null` when the SDK cannot derive a seed safely (e.g. abType is
 * SEMANTIC but no marker source exists; abType is BYTECODE/GRAPH which
 * require additional off-LLM inputs not in v1). The caller treats null as
 * "block locally but do not auto-publish".
 */
export function seedFromTx(
  verdict: RawVerdict,
  tx: ProposedTx | null,
  ctx: CheckContext,
  defaultChainId: number,
): AntibodySeed | null {
  switch (verdict.abType) {
    case "ADDRESS": {
      const target = pickAddressTarget(tx, ctx);
      if (!target) return null;
      return {
        abType: "ADDRESS",
        chainId: tx?.chainId ?? defaultChainId,
        target,
      };
    }
    case "CALL_PATTERN": {
      if (!tx?.to || !tx.data || tx.data.length < 10) return null;
      const selector = tx.data.slice(0, 10) as `0x${string}`;
      const argsTemplate = (`0x${tx.data.slice(10)}`) as `0x${string}`;
      return {
        abType: "CALL_PATTERN",
        chainId: tx.chainId ?? defaultChainId,
        target: normalizeAddress(tx.to),
        selector,
        argsTemplate,
      };
    }
    // BYTECODE: would require an extcodehash fetch we don't do here. v2.
    // GRAPH: requires a taint-set discovery phase. v2.
    // SEMANTIC: cannot derive a marker from raw LLM output without
    // re-introducing injection risk. v2 will use an off-LLM marker source.
    default:
      return null;
  }
}

function pickAddressTarget(tx: ProposedTx | null, ctx: CheckContext): `0x${string}` | null {
  if (tx?.to) return normalizeAddress(tx.to);
  const cp = ctx.counterparty?.id;
  if (cp && isAddress(cp)) return normalizeAddress(cp);
  return null;
}
