import {
  type AntibodyType,
  AntibodyTypeValue,
  type SemanticFlavor,
  SemanticFlavorValue,
  type Verdict,
  VerdictValue,
} from "../types/antibody.js";
import { TeeResponseError } from "../types/errors.js";

export interface RawVerdict {
  verdict: "MALICIOUS" | "SUSPICIOUS" | "BENIGN";
  abType: AntibodyType;
  flavor: SemanticFlavor | null;
  confidence: number;
  severity: number;
  reasoning: string;
  /**
   * Verbatim substring extracted by the LLM for SEMANTIC verdicts. The
   * parser carries it through as-is; downstream `seedFromTx` validates
   * length, multi-word shape, denylist membership, and verbatim presence
   * in the bundle before allowing it to seed an antibody. Always null for
   * non-SEMANTIC abTypes.
   */
  marker: string | null;
}

const ABTYPE_KEYS = new Set(Object.keys(AntibodyTypeValue));
const VERDICT_KEYS = new Set([...Object.keys(VerdictValue), "BENIGN"]);
const FLAVOR_KEYS = new Set(Object.keys(SemanticFlavorValue));

/**
 * Parse the TEE's strict-JSON response into a typed `RawVerdict`. Refuses
 * unknown enum values, out-of-range numbers, or surrounding prose.
 *
 * The parser is deliberately strict: it never extracts free text from the
 * model output into anything that becomes part of an antibody envelope.
 * Only the enum fields and bounded numerics are trusted; `reasoning` is
 * carried forward as a `reasonSummary` for the public envelope but never
 * used to derive a matcher.
 */
export function parseVerdict(raw: string): RawVerdict {
  const trimmed = raw.trim();
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBody(trimmed));
  } catch (err) {
    throw new TeeResponseError(`response is not valid JSON: ${describe(err)}`, { cause: err });
  }
  if (!isObject(json)) throw new TeeResponseError("response JSON is not an object");

  const verdict = enumOrThrow<RawVerdict["verdict"]>(json.verdict, VERDICT_KEYS, "verdict");
  const abType = enumOrThrow<AntibodyType>(json.abType, ABTYPE_KEYS, "abType");
  // Flavor is meaningful only for SEMANTIC; for any other abType we coerce
  // to null silently. the LLM sometimes returns a flavor on ADDRESS / CALL_PATTERN
  // verdicts despite the prompt asking it not to. Hard-rejecting on that
  // would discard otherwise-good verdicts; flavor isn't load-bearing on the
  // matcher side except for SEMANTIC.
  const flavor =
    abType !== "SEMANTIC"
      ? null
      : json.flavor === null || json.flavor === undefined
        ? null
        : enumOrThrow<SemanticFlavor>(json.flavor, FLAVOR_KEYS, "flavor");
  const confidence = clampInt(json.confidence, "confidence");
  const severity = clampInt(json.severity, "severity");
  const reasoning = typeof json.reasoning === "string" ? json.reasoning : "";
  // Marker is meaningful only for SEMANTIC; coerce silently otherwise so we
  // do not reject otherwise-valid verdicts when the model attaches a marker
  // to e.g. an ADDRESS verdict.
  const marker =
    abType !== "SEMANTIC"
      ? null
      : typeof json.marker === "string" && json.marker.trim().length > 0
        ? json.marker
        : null;

  return { verdict, abType, flavor, confidence, severity, reasoning, marker };
}

/**
 * Some models occasionally wrap their JSON in a single ```json ... ```
 * fence even when told not to. Strip that without softening the rest of
 * the strictness.
 */
function extractJsonBody(s: string): string {
  if (s.startsWith("```")) {
    const end = s.lastIndexOf("```");
    if (end > 3) return s.slice(s.indexOf("\n") + 1, end).trim();
  }
  return s;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function enumOrThrow<T extends string>(value: unknown, allowed: Set<string>, field: string): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TeeResponseError(`invalid ${field}: ${JSON.stringify(value)}`);
  }
  return value as T;
}

function clampInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new TeeResponseError(`${field} must be an integer in [0,100]`);
  }
  return Math.floor(n);
}

function describe(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

/**
 * The TEE-produced verdict combined with publisher-side decisions about
 * which observable fact to encode as the matcher seed. The Immunity facade
 * uses this to call `publish()` with deterministic seed inputs, never
 * with strings extracted from `reasoning`.
 */
export interface VerdictDecision {
  raw: RawVerdict;
  treatAsBlock: boolean;
  treatAsEscalate: boolean;
}

export function decideFromVerdict(
  raw: RawVerdict,
  blockThreshold: number,
  escalateThreshold: number,
): VerdictDecision {
  if (raw.verdict === "BENIGN") {
    return { raw, treatAsBlock: false, treatAsEscalate: false };
  }
  if (raw.verdict === "MALICIOUS" && raw.confidence >= blockThreshold) {
    return { raw, treatAsBlock: true, treatAsEscalate: false };
  }
  if (raw.confidence >= escalateThreshold) {
    return { raw, treatAsBlock: false, treatAsEscalate: true };
  }
  return { raw, treatAsBlock: false, treatAsEscalate: false };
}

// Wire the validated raw verdict to the typed enums, since downstream
// callers want the contract-aligned strings.
export function asVerdictEnum(raw: RawVerdict): Verdict | null {
  if (raw.verdict === "BENIGN") return null;
  return raw.verdict;
}
