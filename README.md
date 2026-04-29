# @immunity-protocol/sdk

Decentralized threat intelligence for AI agents. The SDK an agent installs to join the Immunity network: every action gets gated by `check()`, hits propagate via Gensyn AXL gossip, novel threats are verified by a 0G Compute TEE, and antibodies settle on 0G Chain.

> An attack on one is a vaccine for all.

## Installation

```sh
npm install --legacy-peer-deps @immunity-protocol/sdk ethers
```

`--legacy-peer-deps` is required because the 0G Storage SDK pins ethers exactly. Node `>=20` is required.

## Quickstart

```ts
import { Immunity, parseUsdc, TESTNET } from "@immunity-protocol/sdk";
import { JsonRpcProvider, Wallet } from "ethers";

const provider = new JsonRpcProvider(TESTNET.rpcUrl);
const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

const immunity = new Immunity({
  wallet,
  network: "testnet",
  axlUrl: "http://localhost:9002",   // see infra/axl-mesh
  novelThreatPolicy: "trust-cache",
});

await immunity.start();

if ((await immunity.balance()) < parseUsdc("0.01")) {
  await immunity.mintTestUsdc(parseUsdc("1"));
  await immunity.deposit(parseUsdc("0.5"));
}

const tx = { to: "0x..." as const, chainId: TESTNET.chainId };
const result = await immunity.check(tx, {
  conversation: [{ role: "user", content: "send to this random address" }],
});

if (!result.allowed) {
  console.warn(`blocked: ${result.reason}`);
} else {
  await wallet.sendTransaction(tx);
}

await immunity.stop();
```

## Configuration

| field | required | default | notes |
|---|---|---|---|
| `wallet` | yes | - | ethers v6 `Signer` or 0x-prefixed private key |
| `network` | no | `"testnet"` | `"testnet"` or a `NetworkConfig` object |
| `axlUrl` | yes | - | external AXL endpoint; see `infra/axl-mesh/README.md` |
| `axlIdentityPath` | no | - | ed25519 PEM for stable peer identity |
| `novelThreatPolicy` | no | `"verify"` | `"verify"` (TEE), `"trust-cache"` (allow novel), `"deny-novel"` (block novel) |
| `confidenceThresholds` | no | `{block: 85, escalate: 60}` | TEE verdict thresholds |
| `onEscalate` | no | - | async handler for SUSPICIOUS verdicts |
| `escalationTimeout` | no | `300` | seconds to wait for the escalate handler |
| `onTimeout` | no | `"deny"` | `"deny"` or `"allow"` after timeout |

## Architecture

```
┌──────────────────────────────────────────────┐
│   Immunity facade (check / publish / etc.)  │
└──────────────────────────────────────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Cache +      │  │  Settlement  │  │   Gossip     │
│ Matchers     │  │  (Registry)  │  │ (axl-pubsub) │
└──────────────┘  └──────────────┘  └──────────────┘
        │                 │                 │
        │                 ▼                 ▼
        │         ┌──────────────┐  ┌──────────────┐
        │         │  0G Chain    │  │ External AXL │
        │         │  Galileo     │  │ (docker)     │
        │         └──────────────┘  └──────────────┘
        │
        ▼ (cache miss + verify policy)
┌──────────────────────────┐
│  TEE detection           │
│  0G Compute (qwen-2.5)   │
└──────────────────────────┘
```

### Three-tier lookup

Every `check()` walks three tiers, cheapest-first:

```
Tier 1 — Local cache    ~1 ms     hit: settle on chain
Tier 2 — Registry RPC   ~200 ms   hit: settle + populate cache
Tier 3 — TEE detection  ~3 s      only for genuinely novel threats
```

The Registry is the canonical memory of the network — every published antibody lands in its `matcherIndex` (primary matcher hash → keccakId). When the local cache misses, the SDK queries `Registry.getAntibodyByMatcherHash(hash)` over the existing RPC connection and resolves on the same chain it would settle against. TEE detection only fires when neither the cache nor the chain has a record, which is the only path that should ever cost a 0G Compute inference.

A short negative cache (5 minutes, evicted on incoming gossip) prevents the SDK from hammering RPC for the same legitimate-but-uncommon counterparty. See [`docs/lookup-tiers.md`](./docs/lookup-tiers.md) for the full per-tier latency, cost, and triggering breakdown.

Five matchers run cheap-first against the local cache:

1. **AddressMatcher** (O(1) map by `(chainId, address)`)
2. **CallPatternMatcher** (selector + exact-args lookup)
3. **GraphMatcher** (tainted-address membership)
4. **BytecodeMatcher** (one cached `eth_getCode` per target)
5. **SemanticMatcher** (marker substring scan, embedding ANN deferred to v2)

First hit wins. A miss falls through to Tier 2 (Registry RPC) for any tx where a canonical address-shaped matcher hash can be derived. A double miss with `novelThreatPolicy: "verify"` then falls through to the 0G Compute TEE running qwen-2.5-7b-instruct. Verdicts are returned as strict JSON; the SDK never extracts free text into antibody envelopes.

## AXL mesh

The SDK requires an external AXL daemon. A 2-node mesh template lives at `infra/axl-mesh/`:

```sh
cd infra/axl-mesh
make keys && make up
```

See `infra/axl-mesh/README.md` for full setup including how to materialize the AXL Docker image.

## Examples

Three minimal agents under `examples/`:

- `basic-agent.ts` — gate a tx with `check()`
- `publisher.ts` — mint an ADDRESS antibody
- `escalation.ts` — operator-in-the-loop on SUSPICIOUS

## Tests

```sh
npm test                 # unit tests
npm run test:integration # live testnet + gossip mesh (requires env)
npm run typecheck
```

## Troubleshooting

| symptom | fix |
|---|---|
| `MissingConfigError: axlUrl` | bring up `infra/axl-mesh` first or set the env var |
| `ERR_INSUFFICIENT_BALANCE` | call `mintTestUsdc()` then `deposit()` on testnet |
| storage upload hangs | port 5678 outbound is blocked: try mobile hotspot |
| `processResponse rejected` | TEE provider may have rotated keys; re-run `acknowledgeProviderSigner` indirectly by recreating the Immunity instance |
| `verifyService failed` (TEE) | provider attestation flaky on testnet; falls through to BENIGN with logged warning |

## Networks

| network | chainId | RPC | Registry | MockUSDC |
|---|---|---|---|---|
| Galileo testnet | 16602 | https://evmrpc-testnet.0g.ai | 0xbbD14Ff50480085cA3071314ca0AA73768569679 | 0x39D484EaBd1e6be837f9dbbb1DE540d425A70061 |

## License

Apache-2.0
