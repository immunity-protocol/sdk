import { flattenContext } from "../matchers/semantic-flatten.js";
import { normalizeSemanticText } from "../matchers/semantic-normalize.js";
import type { AntibodySeed, SemanticFlavor } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";
import { isAddress, normalizeAddress } from "../util/address.js";
import type { RawVerdict } from "./parse.js";

/**
 * Deterministic mapping from a TEE verdict to an AntibodySeed using ONLY
 * observable facts (proposed tx fields, counterparty id, plus an
 * optionally-validated SEMANTIC marker substring extracted by the LLM).
 *
 * The injection-defense contract: an attacker who controls the encrypted
 * context bundle cannot influence which address or pattern the resulting
 * antibody flags. For ADDRESS / CALL_PATTERN seeds we read directly from
 * the proposal supplied by the call site (immune to bundle manipulation).
 * For SEMANTIC seeds we let the LLM nominate a marker substring, but
 * apply a battery of guardrails before trusting it (see `validateMarker`).
 *
 * Returns `null` when the SDK cannot derive any seed safely. The caller
 * treats null as "block locally but do not auto-publish".
 */
export function seedFromTx(
  verdict: RawVerdict,
  tx: ProposedTx | null,
  ctx: CheckContext,
  defaultChainId: number,
  semanticAutoMint = false,
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
    case "SEMANTIC": {
      // Opt-in path: callers that enable `semanticAutoMint` allow the
      // SDK to mint SEMANTIC antibodies from TEE verdicts. The LLM
      // supplies a candidate marker; the SDK validates it before use.
      // Validation failure falls through to the same ADDRESS fallback
      // BYTECODE / GRAPH use, which is still a useful (if narrower)
      // signal: the agent was about to send to a known-bad counterparty.
      if (semanticAutoMint) {
        // The CRE returns the verbatim injection marker it extracted in-TEE
        // (NovelVerification.Result.marker); the SDK validates it (length, word
        // count, denylist, and substring-of-bundle anti-hallucination) before use.
        const marker = verdict.marker?.trim() ?? null;
        if (marker && verdict.flavor && validateMarker(marker, ctx)) {
          return {
            abType: "SEMANTIC",
            flavor: verdict.flavor,
            // Store the normalized marker so the value hashed into
            // primaryMatcherHash is byte-identical to what the matcher scans
            // for (M-5): matcher marker == validator-approved marker.
            pattern: { kind: "marker", value: normalizeSemanticText(marker) },
          };
        }
      }
      return addressFallback(tx, ctx, defaultChainId);
    }
    // BYTECODE / GRAPH: when the LLM picks one of these abTypes we cannot
    // mint at that granularity safely in v1 (both need off-chain enrichment
    // not present here). However, if the proposed action has a concrete
    // tx.to, the address IS an observable, deterministic target the network
    // will care about: the agent is about to send to it, and blocking that
    // address protects everyone. Fall back to ADDRESS using tx.to. The
    // fallback is still injection-safe because tx.to is supplied by the
    // call site, not by anything the LLM said.
    case "BYTECODE":
    case "GRAPH":
      return addressFallback(tx, ctx, defaultChainId);
    default:
      return null;
  }
}

function addressFallback(
  tx: ProposedTx | null,
  ctx: CheckContext,
  defaultChainId: number,
): AntibodySeed | null {
  const target = pickAddressTarget(tx, ctx);
  if (!target) return null;
  return {
    abType: "ADDRESS",
    chainId: tx?.chainId ?? defaultChainId,
    target,
  };
}

function pickAddressTarget(tx: ProposedTx | null, ctx: CheckContext): `0x${string}` | null {
  if (tx?.to) return normalizeAddress(tx.to);
  const cp = ctx.counterparty?.id;
  if (cp && isAddress(cp)) return normalizeAddress(cp);
  return null;
}

/**
 * Length floor. Below this the marker is likely a generic word that would
 * cause network-wide false positives (every legitimate agent doing a swap
 * or approval would hit it). 20 chars is roughly "three short words".
 */
const MARKER_MIN_LEN = 20;

/**
 * Length ceiling. Above this the marker is likely a sentence-or-paragraph
 * lift, which is brittle: tiny variations in the attacker's surrounding
 * text would miss the substring scan. Forces the LLM to pick a phrase
 * rather than a passage.
 */
const MARKER_MAX_LEN = 100;

/**
 * Minimum word count. Belt-and-suspenders against the length floor: a
 * single very long compound word would pass on length but still be too
 * generic. Phrases of three or more words are specific enough to be safe
 * antibodies.
 */
const MARKER_MIN_WORDS = 3;

/**
 * Phrases the LLM occasionally returns that read as "marker-shaped" but
 * appear in legitimate agent flows often enough that minting an antibody
 * on them would block honest activity. Compared with the marker after
 * lowercase + whitespace collapse and exact equality.
 */
const MARKER_DENYLIST: ReadonlySet<string> = new Set([
  "approve token contract",
  "approve the token",
  "transfer all tokens",
  "send the funds",
  "swap usdc for eth",
  "sign this transaction",
  "confirm the transaction",
  "claim airdrop tokens",
]);

/**
 * Validate an LLM-supplied SEMANTIC marker before allowing it to seed an
 * antibody. All guardrails must pass:
 *
 *  1. Length within [MARKER_MIN_LEN, MARKER_MAX_LEN].
 *  2. At least MARKER_MIN_WORDS whitespace-separated tokens.
 *  3. Lowercase / whitespace-collapsed form is not in MARKER_DENYLIST.
 *  4. Marker appears (case-insensitively) as a verbatim substring of the
 *     bundle's flattened text. This is the anti-hallucination guard: the
 *     LLM cannot make up a marker that lives outside the input it was
 *     given. Without this check, an attacker who manages to bias the
 *     LLM's output could mint antibodies on phrases the network has
 *     never actually seen.
 *
 * Failure on any check causes the caller to fall back to the ADDRESS
 * seed path (or null if no address target exists).
 */
function validateMarker(marker: string, ctx: CheckContext): boolean {
  if (marker.length < MARKER_MIN_LEN || marker.length > MARKER_MAX_LEN) return false;

  const collapsed = marker.toLowerCase().replace(/\s+/g, " ").trim();
  if (collapsed.split(" ").length < MARKER_MIN_WORDS) return false;
  if (MARKER_DENYLIST.has(collapsed)) return false;

  // Anti-hallucination substring guard, normalized identically to the matcher
  // (M-5): a marker that passes here is exactly what the matcher will scan for.
  const haystack = normalizeSemanticText(flattenContext(ctx));
  if (!haystack.includes(normalizeSemanticText(marker))) return false;

  // Flavor presence is enforced by the caller before reaching this point
  // (the SEMANTIC branch in seedFromTx checks verdict.flavor truthiness),
  // but a defensive read keeps the contract self-evident here.
  return true;
}

// Exported for tests: verifying guardrail contract directly without going
// through the full seedFromTx switch is useful when adding new failure
// modes to the validator.
export const __testing = { validateMarker, MARKER_DENYLIST } as { validateMarker: typeof validateMarker; MARKER_DENYLIST: ReadonlySet<string> };

export type { SemanticFlavor };
