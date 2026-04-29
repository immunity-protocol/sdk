import type { CheckContext } from "../types/context.js";

/**
 * Flatten the text-bearing parts of a CheckContext into a single
 * space-joined string. Used by:
 *
 *  - SemanticMatcher (Tier-1 substring marker scan)
 *  - The TEE seed validator: when the LLM supplies a marker substring on
 *    a SEMANTIC verdict, we require the marker to actually appear in this
 *    flattened text (anti-hallucination guard before auto-minting a
 *    SEMANTIC antibody).
 *
 * Both call sites must use the same flattening rules, otherwise the
 * marker the matcher would scan against could differ from the marker the
 * validator approved.
 */
export function flattenContext(ctx: CheckContext): string {
  const parts: string[] = [];
  for (const turn of ctx.conversation ?? []) parts.push(turn.content);
  for (const t of ctx.toolTrace ?? []) parts.push(t.tool, JSON.stringify(t.args));
  for (const s of ctx.sources ?? []) {
    parts.push(s.url);
    if (s.extractedText) parts.push(s.extractedText);
  }
  if (ctx.counterparty) {
    parts.push(ctx.counterparty.id);
    if (ctx.counterparty.ens) parts.push(ctx.counterparty.ens);
  }
  return parts.join(" ");
}
