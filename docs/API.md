# API reference

Public surface of `@immunity-protocol/sdk`. All async unless noted.

## `class Immunity`

### `new Immunity(config)`

`config: ImmunityConfig`. Throws `MissingConfigError` if `axlUrl` or `wallet` is absent. Construction is non-mutating; no network or chain calls happen here.

### `start(): Promise<void>`

Connects the signer to a provider, instantiates the Registry and USDC clients, attaches the five matchers to the cache, opens the AXL gossip subscription. Idempotent: a second call is a no-op.

### `stop(): Promise<void>`

Closes the gossip subscription, drains the AXL connection. Idempotent.

### `check(tx, context, options?): Promise<CheckResult>`

The hot path.

- `tx: ProposedTx | null` — `{ to, value?, data?, chainId? }` for an EVM action, or `null` for non-EVM agent actions.
- `context: CheckContext` — conversation, tools, sources, counterparty, metadata. All optional.
- `options.policy?: NovelThreatPolicy` — override the configured `novelThreatPolicy` for this call only.

Returns:

```ts
{
  allowed: boolean;
  decision: "allow" | "block" | "escalate";
  source: "cache" | "tee" | "policy";
  confidence: number;       // 0..100
  antibodies: Antibody[];   // matched antibodies, empty for "allow"
  reason: string;
  checkId: Hex32 | null;    // settlement tx hash, null on action-gated short-circuit
  novel: boolean;           // true when "allow" came from cache miss + no TEE
}
```

### `publish(input): Promise<PublishResult>`

Explicit antibody mint. The SDK auto-publishes from TEE verdicts; call this directly when you have a heuristic publisher.

```ts
const r = await immunity.publish({
  seed: { abType: "ADDRESS", chainId: 16602, target: "0xBAD..." },
  verdict: "MALICIOUS",
  confidence: 95,
  severity: 90,
});
// { keccakId, immSeq, txHash, params }
```

### `deposit(amount, approveMode?)`

Top up the prepaid USDC balance held by the Registry. Auto-approves the allowance if needed (`"exact"` default, or `"max"` for once-and-done).

### `withdraw(amount): Promise<Hex32>`

Pulls USDC out of the Registry. Subject to stake-lock if amounts include staked positions.

### `balance(): Promise<bigint>`

Current prepaid balance (6 decimals, integer base units).

### `publisherStats(): Promise<PublisherStats>`

`{ totalStaked, totalEarned, publishedCount, slashedCount }`.

### `getAntibody(idOrSeq): Promise<Antibody>`

`idOrSeq: Hex32 | number`. `Hex32` resolves via `getAntibody`; `number` resolves via `getAntibodyByImmSeq`.

### `sweep(): Promise<SweepResult>`

Standalone sweep call. The same sweep runs opportunistically inside `check()`, so most users never need this.

### `mintTestUsdc(amount): Promise<Hex32>`

Testnet bootstrap. Calls MockUSDC's public `mint(to, amount)`. Throws on real-USDC contracts.

## Types

### `Antibody`

The contract-aligned envelope, with an additional `seed` field carried on gossip for matcher index reconstruction. See `src/types/antibody.ts`.

### `AntibodySeed`

Discriminated union by `abType`. Provides the original matcher inputs so subscribers can rebuild type-specific lookups locally.

### `CheckContext`

```ts
{
  conversation?: ConversationTurn[];
  toolTrace?: ToolCall[];
  sources?: Source[];
  counterparty?: { id: string; ens?: string };
  metadata?: Record<string, unknown>;
}
```

## Errors

All errors extend `ImmunityError`. Stable `code` strings:

| class | code |
|---|---|
| `MissingConfigError` | `ERR_MISSING_CONFIG` |
| `NotStartedError` | `ERR_NOT_STARTED` |
| `BlockError` | `ERR_BLOCKED` |
| `EscalationError` | `ERR_ESCALATION_TIMEOUT` / `_DENIED` / `_NO_HANDLER` |
| `InsufficientBalanceError` | `ERR_INSUFFICIENT_BALANCE` |
| `NetworkError` | `ERR_NETWORK` |
| `AntibodyNotFoundError` | `ERR_ANTIBODY_NOT_FOUND` |
| `DuplicateAntibodyError` | `ERR_DUPLICATE_ANTIBODY` |
| `StakeLockedError` | `ERR_STAKE_LOCKED` |
| `TeeAttestationError` | `ERR_TEE_ATTESTATION` |
| `TeeResponseError` | `ERR_TEE_RESPONSE` |

## Hash helpers (re-exported)

For tooling and mirror-contract integrations:

- `computeKeccakId(abType, flavor, primaryMatcherHash, publisher)`
- `hashAddressMatcher`, `hashCallPatternMatcher`, `hashBytecodeMatcher`, `hashGraphMatcher`, `hashSemanticMatcher`
- `computeTaintSetId` for the GRAPH auxiliary event indexer
- `parseUsdc`, `formatUsdc`, `USDC_DECIMALS`
- `normalizeAddress`, `isAddress`, `chainAddressKey`

All match the on-chain canonicalization byte-for-byte (verified by `test/integration/keccak-parity.test.ts`).
