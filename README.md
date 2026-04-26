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

Five matchers run cheap-first against the local cache:

1. **AddressMatcher** (O(1) map by `(chainId, address)`)
2. **CallPatternMatcher** (selector + exact-args lookup)
3. **GraphMatcher** (tainted-address membership)
4. **BytecodeMatcher** (one cached `eth_getCode` per target)
5. **SemanticMatcher** (marker substring scan, embedding ANN deferred to v2)

First hit wins. A miss with `novelThreatPolicy: "verify"` falls through to the 0G Compute TEE running qwen-2.5-7b-instruct. Verdicts are returned as strict JSON; the SDK never extracts free text into antibody envelopes.

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
| Galileo testnet | 16602 | https://evmrpc-testnet.0g.ai | 0x45Ee45Ca358b3fc9B1b245a8f1c1C3128caC8e48 | 0x2Aee1d140422C62AE23465596801C35f3Ce74F9E |

## License

Apache-2.0
