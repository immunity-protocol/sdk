/**
 * Shared semantic-text normalization (security fix M-5).
 *
 * The v1 semantic matcher is a substring scan. A naive `toLowerCase()` scan is
 * evadable: zero-width characters, Unicode look-alikes, and whitespace tricks
 * split an indexed marker so the raw substring check misses it. This single
 * function is the canonical normalizer applied IDENTICALLY at every semantic
 * call site — the matcher haystack, each indexed marker, and the seed
 * validator's approved/stored marker — so the marker the matcher scans for is
 * always byte-equal to the marker the validator approved (and hashed).
 *
 * Steps (order matters):
 *   1. Unicode NFKC — fold compatibility look-alikes to canonical forms.
 *   2. Strip zero-width / invisible code points an attacker can splice into a
 *      marker without changing how it reads.
 *   3. Collapse any run of whitespace to a single space, then trim.
 *   4. Lowercase.
 *
 * Idempotent: `normalizeSemanticText(normalizeSemanticText(s)) === normalizeSemanticText(s)`.
 */

// Zero-width and invisible formatting code points: ZWSP/ZWNJ/ZWJ (U+200B–200D),
// LTR/RTL marks (U+200E–200F), soft hyphen (U+00AD), word joiner + invisible
// math operators (U+2060–2064), BOM/ZWNBSP (U+FEFF), and the BiDi
// embedding/override/isolate controls (U+202A–202E, U+2066–2069) that can be
// interleaved into a marker to break a substring scan.
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function normalizeSemanticText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
