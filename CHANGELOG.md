# Changelog

All notable changes to the Immunity SDK are recorded here. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0]

### Added

- **TEE-derived SEMANTIC antibodies** (opt-in via `Immunity.semanticAutoMint`). The TEE prompt now requests a verbatim `marker` substring on SEMANTIC verdicts; the SDK validates length (20-100 chars), multi-word shape (>= 3 whitespace-separated tokens), denylist of generic phrases, and verbatim presence in the flattened bundle before allowing the marker to seed an antibody. Validation failure falls back to the v0.4 ADDRESS-seed behavior, so the upgrade is additive.
- Shared `flattenContext` helper at `src/matchers/semantic-flatten.ts`, used by both `SemanticMatcher` (Tier-1 substring scan) and the new TEE seed validator (anti-hallucination guard). Same flattening rules at both call sites by construction.

### Changed

- `RawVerdict` now carries an optional `marker: string | null` field. Non-SEMANTIC verdicts coerce to `null` silently to match the existing tolerance of stray `flavor` values.
- `seedFromTx` accepts a fifth argument, `semanticAutoMint`, defaulting to `false`. `TeeVerifierOptions` and `ImmunityConfig` expose the same flag for caller opt-in.

### Notes

The injection-defense contract from v0.4 still holds: `tx.to`, selectors, and counterparty IDs come from the call site, not from LLM output. The new path lets the LLM nominate a SEMANTIC marker but only mints when the marker is provably present in the bundle the SDK can see, multi-word, long enough to be specific, and not on the generic-phrase denylist. Off by default to keep existing callers on the conservative path.
