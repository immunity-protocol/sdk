# Changelog

All notable changes to the Immunity SDK are recorded here. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.10]

### Fixed

- **Tier-2 lookup ignores SLASHED / EXPIRED antibodies.** `Tier2LookupClient.firstMatch` was returning any entry that existed at the matcher hash, regardless of its `status` field. Tier-1 matchers correctly filter on `status === "ACTIVE"`, so a slashed antibody would silently re-fire through Tier-2 once the local cache was refreshed, defeating the on-chain `slash` retire path. Now `firstMatch` mirrors the Tier-1 status filter and falls through non-ACTIVE candidates.

## [0.6.9]

### Added

- **`ImmunityConfig.denyKeccakIds`** — config-level antibody mute list. When `check()` would return a block decision for a keccak in this set (whether from Tier-1 cache or Tier-2 chain lookup), `check-flow` treats it as a miss and falls through to the next tier. Local-only filter; each agent applies it independently. Use case: retire a bad auto-mint when on-chain `slash` isn't reachable (the deployed Registry's `slash` is owner-only and the operator may not hold the owner key). The 0.6.8 `dropFromCache` only filtered Tier-1; this closes the Tier-2 hole where the chain's matcher index re-introduces the entry on every check.

## [0.6.8]

### Added

- **`Immunity.dropFromCache(keccakId)`** — local-only retire of a single antibody. Useful when an entry got published on chain but the running agent shouldn't act on it (a known-bad auto-mint that operator wants to retire before a chain-side `slash` is available, or a publisher to mute locally). The matchers' subscriber wiring fires a delete event that clears the entry from each Tier-1 index. Subsequent gossip / bootstrap can re-add the entry — callers are responsible for re-applying the drop if the filter should be persistent.

## [0.6.7]

### Added

- **`ImmunityConfig.teeVerifier`** — pluggable verifier hook. Replaces the default 0G Compute TEE callback used on `start()`. Same signature (`(tx, ctx) => Promise<TeeVerifyOutcome | null>`), same outcome shape; the SDK calls it from `check-flow.ts` whenever the cache and registry layers don't match. Lets agents whose wallets can't reach the 0G Compute ledger's 3 OG protocol minimum swap in a hosted-LLM shim (e.g. Anthropic Claude) without forking the SDK. The integrity guarantees of the 0G TEE (signed inference, attestation) are NOT replicated by alternative backends; the choice is the caller's.
- Re-exports `TeeVerifyFn`, `TeeVerifyOutcome`, `buildVerdictPrompt`, `distillBundle`, `parseVerdict`, `RawVerdict` from the package root so callers can build a compatible verifier without reaching into internals.

## [0.6.6]

### Fixed

- **Bootstrap reconstructs SEMANTIC seeds from `envelope.markerHint`.** 0.6.4 unblocked ADDRESS antibodies on the bootstrap path; SEMANTIC entries stayed seedless because the public envelope only exposes a 64-char `markerHint`, not the full marker (privacy posture). For substring matching the prefix is usually enough — incident content bundles the canonical marker verbatim and a 64-char prefix is rare enough not to false-positive on benign text. Antibodies whose full markers exceed 64 chars match only on the prefix until a live gossip arrival upgrades the seed; an acceptable concession given the alternative is no SEMANTIC matches at all on a chain-only-bootstrapped agent.

## [0.6.5]

### Fixed

- **AddressMatcher decodes ERC-20 and Uniswap calldata to find the real counterparty.** The pre-0.6.5 matcher only probed `tx.to` and `context.counterparty.id`. For any tx routed through a token contract or a DEX router — i.e. virtually all agent activity — `tx.to` is the contract address (USDC, the swap router, etc.), and the malicious recipient/spender lives one level deeper in the calldata. Result: ADDRESS antibodies were dead weight against normal agent flow. New `extractCounterparties` decoder pulls every recipient/spender/path-hop from `transfer`, `transferFrom`, `approve`, Uniswap V2 (`swapExactTokensForTokens` / `…ForETH` / `…ETHForTokens`) and Uniswap V3 (`exactInputSingle` / `exactInput`, both with-deadline and SwapRouter02 shapes), and the matcher probes that union alongside `tx.to`. The whole "look at what the agent is about to do, not just where the bytes are addressed" thesis only works if we actually look — this is that.

## [0.6.4]

### Fixed

- **Cache bootstrap rebuilds ADDRESS seeds from the public envelope** — `Antibody.seed` is the input the AddressMatcher / SemanticMatcher use to build their lookup indices, but the Registry contract stores only `primaryMatcherHash`, so a chain-only fetch yields a seedless antibody that the matchers silently skip. Result: a freshly bootstrapped agent had a populated cache that couldn't actually fire — the "we hydrated but Tier-1 lookups never hit" bug observed against the 45-antibody genesis catalog. Bootstrap now optionally accepts a `StorageClient`; when provided, it fetches each antibody's `evidenceCid` envelope from 0G storage and reconstructs the seed for ADDRESS-typed entries (the public envelope exposes `chainId` + `target` for that kind). SEMANTIC envelopes intentionally redact the marker text — those antibodies still hydrate seedless and need a live gossip arrival to populate their seed; the markerHint isn't enough for substring scanning.
- `Immunity.start()` threads its 0G storage client into the bootstrap call automatically when configured, so existing callers inherit the fix with no code change.

## [0.6.3]

### Changed

- **`ImmunityConfig.bootstrap.fetchRetries` is now public** — the field already worked at the implementation layer (`bootstrapCacheFromRegistry`), but was missing from the public type, so passing it from a TypeScript caller was a compile error. Bumping it from the default 3 to 5 helps the packed-fleet bootstrap tolerate sustained RPC throttling.

## [0.6.2]

### Fixed

- **`check()` no longer swallows decisions when on-chain settlement fails** — `runCheck` previously called `settleCheck` after every Tier-1 / Tier-2 / TEE decision and propagated the settlement error to the caller, which on flaky public RPCs (the 0G testnet's intermittent "no matching receipts found" / `eth_getTransactionReceipt` retries) meant every cache hit surfaced as a generic error to the agent. Result: dashboards showing zero blocks even when antibodies were firing correctly. Settlement failures are now caught, logged, and surfaced as `txHash: null` while the decision is returned normally — the cache/registry/TEE answer is already authoritative for the in-process control flow; on-chain settlement is best-effort telemetry that should not gate it.

## [0.6.1]

### Fixed

- **Bootstrap retry on transient RPC failures** — `bootstrapCacheFromRegistry` now retries each `getAntibodyByImmSeq` up to 3 times with exponential backoff (configurable via `bootstrap.fetchRetries`). 0G's read replicas occasionally return `CALL_EXCEPTION ("missing revert data")` for valid seqs under heavy concurrent load; the previous one-shot fetch counted these as `missing` and left the cache partially populated, which directly caused agents to allow attacks they should have blocked. `AntibodyNotFoundError` is still treated as a real gap and not retried.
- **Ledger create floor at protocol minimum** — `ensureLedger` now floors the initial `addLedger` deposit at the 3 OG hard minimum imposed by `LedgerBroker.addLedger`. The 0.6.0 `minLedgerOg` config is the *check threshold* (when do we top up?), not the *create amount*; passing `minLedgerOg: 0.1` previously crashed TEE init with "Minimum balance to create a ledger is 3 0G", silently disabling the TEE verifier and degrading the `verify` policy to permissive trust-cache. Wallets still need 3+ OG to bootstrap a fresh ledger; the fix surfaces the requirement instead of failing late.

## [0.6.0]

### Added

- **Cache hydration from on-chain Registry** — `Immunity.start()` now reads `nextImmSeq` and iterates `getAntibodyByImmSeq(1..N)`, populating the local cache before returning. Solves the "late joiner" problem: peers that connect after a one-shot publish missed the original gossip burst now see the full catalog before their first `check()`. Configurable via `bootstrapCacheOnStart` (default `true`) and `bootstrap.{concurrency, limit}` in `ImmunityConfig`. Internal `bootstrapCacheFromRegistry()` exported from `src/cache/bootstrap.ts` for direct use in tests / one-shot scripts.
- **Tunable TEE Compute ledger thresholds** — `ImmunityConfig.minLedgerOg` / `minProviderOg` (and the equivalent `TeeVerifierOptions` fields) override the broker's default 3 OG / 1 OG floors. Lets agents with small wallets reach a working TEE without per-agent funding topups.
- **`Immunity.ensureTeeFunded({ minLedgerOg?, minProviderOg? })`** — explicit, idempotent fund-the-broker entrypoint for callers (e.g. an agent's boot sequence) that don't want to wait for the lazy TEE init triggered by the first novel-threat check.

### Changed

- `RegistryMethods` now includes `nextImmSeq()` so the bootstrap helper can read the catalog count without a manual cast.

## [0.5.0]

### Added

- **TEE-derived SEMANTIC antibodies** (opt-in via `Immunity.semanticAutoMint`). The TEE prompt now requests a verbatim `marker` substring on SEMANTIC verdicts; the SDK validates length (20-100 chars), multi-word shape (>= 3 whitespace-separated tokens), denylist of generic phrases, and verbatim presence in the flattened bundle before allowing the marker to seed an antibody. Validation failure falls back to the v0.4 ADDRESS-seed behavior, so the upgrade is additive.
- Shared `flattenContext` helper at `src/matchers/semantic-flatten.ts`, used by both `SemanticMatcher` (Tier-1 substring scan) and the new TEE seed validator (anti-hallucination guard). Same flattening rules at both call sites by construction.

### Changed

- `RawVerdict` now carries an optional `marker: string | null` field. Non-SEMANTIC verdicts coerce to `null` silently to match the existing tolerance of stray `flavor` values.
- `seedFromTx` accepts a fifth argument, `semanticAutoMint`, defaulting to `false`. `TeeVerifierOptions` and `ImmunityConfig` expose the same flag for caller opt-in.

### Notes

The injection-defense contract from v0.4 still holds: `tx.to`, selectors, and counterparty IDs come from the call site, not from LLM output. The new path lets the LLM nominate a SEMANTIC marker but only mints when the marker is provably present in the bundle the SDK can see, multi-word, long enough to be specific, and not on the generic-phrase denylist. Off by default to keep existing callers on the conservative path.
