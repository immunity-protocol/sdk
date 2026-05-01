# Challenges encountered while building the SDK

Untracked file. Notes on obstacles hit during implementation, with the workaround that ended up shipping.

## TypeScript strict mode + ethers v6 dynamic Contract methods

`ethers.Contract` exposes contract methods via a dynamic index signature, which `noUncheckedIndexedAccess: true` resolves to `any | undefined`. Direct `contract.deposit(amount)` calls then fail to type-check.

**Workaround:** declared a `RegistryMethods` (and `UsdcMethods`) interface enumerating the methods we use, cast the constructed `Contract` to `Contract & RegistryMethods` once in `createRegistryClient`. Downstream callers get typed completion without spreading `as any` everywhere.

## 0G Storage SDK ships ethers as CJS, our SDK is ESM

`@0gfoundation/0g-ts-sdk` declares its `Indexer.upload(signer)` parameter against ethers' `lib.commonjs` typings. Our SDK imports `ethers` from `lib.esm`. Same runtime class, different declared identities under TypeScript's structural type-with-private-fields handling.

**Workaround:** cast the signer through `unknown` to the SDK's expected parameter shape at the single call site. Documented inline.

## 0G Storage RetryOpts requires PascalCase keys

`{ Retries, Interval, MaxGasPrice }` is the only accepted form. camelCase silently no-ops.

**Workaround:** baked the PascalCase shape into `createStorageClient` so consumers never see it.

## macOS default openssl is LibreSSL (no ed25519)

Generating an AXL identity locally with `openssl genpkey -algorithm ed25519` errors on stock macOS.

**Workaround:** the alpine container in `immunity-axl-hub` ships GNU openssl which supports ed25519, so the in-container `generate-key.sh` works. For local-host scripts, used Node's `crypto.generateKeyPairSync("ed25519")` which avoids the openssl dependency entirely.

## `npm install --legacy-peer-deps` required

`@0gfoundation/0g-ts-sdk@1.2.2` pins `ethers@6.13.1` exactly; `@nomicfoundation/hardhat-ethers@3.0.8` (transitively reached) wants `^6.14.0`. Default npm 9+ resolution rejects.

**Workaround:** documented in README's installation block. Locks resolved tree to ethers 6.16+, no runtime breakage observed.

## Fly volume must pre-exist before first deploy

`fly deploy` against a config with `[[mounts]]` fails on first run if the named volume doesn't exist in that region.

**Workaround:** documented `fly volume create axl_data --region <r> --size 1` as a one-time prerequisite in `infra` README. Could be automated by the workflow on first deploy, but explicit is fine.

## Fly smoke check transient "machine not found"

On first deploy of `immunity-hub-usa`, `fly deploy` returned `Failed: smoke checks for <id> failed: error getting machine <id> from api: failed to get VM <id>: machine not found`. The machine had actually started fine (logs show AXL up and TCP/9001 listener live).

**Workaround:** ignored the error, verified via `fly status` and `fly logs` that the machine is healthy. Suspect a Fly API race on first launch.

## TypeScript exactOptionalPropertyTypes + optional config fields

Spread of an optional value into an interface property fails when the target type doesn't include `undefined`. Plain `{ foo: maybeUndef }` won't compile.

**Workaround:** `...(maybeUndef ? { foo: maybeUndef } : {})` spread pattern. Verbose but correct.

## Gossip-client identity vs AXL-daemon identity

`axl-pubsub` v0.1.x's `Gossip.dispatch` enforced strict equality between the AXL-layer `X-From-Peer-Id` header (the sending DAEMON's pubkey prefix) and the gossip envelope's `from` (the gossip CLIENT's ed25519 pubkey). For consumers that run gossip out-of-process from the AXL daemon (us, with the SDK in Node and AXL in a sidecar container), these are always different identities and the check rejects every legitimate inbound message. See `FEEDBACK.md` for the upstream fix detail.

**Workaround:** patched `axl-pubsub` (commits `741f3e6` and `fea04e0`) to drop the strict check. Envelope ed25519 signature is the authoritative authenticity source.

## SDK `axlIdentityPath` was effectively required

`axl-pubsub`'s `Gossip` constructor errors with "Gossip requires either keyPair or privateKeyPath" if neither is provided. Our SDK config marked `axlIdentityPath` as optional but didn't auto-generate a fallback, so omitting it threw at `start()`.

**Workaround:** auto-generate an ephemeral ed25519 keypair via `node:crypto` when `axlIdentityPath` is absent, with a logged warning that peer-id won't survive restarts. Production users opt in by setting the path.

## Hub-spoke gossip propagation cold-start

This is the trickier one. With our deployed topology (two hubs in `immunity-axl-hub`, every spoke peers with both hubs, no direct spoke-to-spoke links), spokes can't deliver `sub_ad` messages to each other on cold-start.

Root cause, traced empirically:

1. axl-pubsub's `Advertiser.gatherPeers()` (in `node_modules/axl-pubsub/src/advertiser.ts`) reads target pubkeys from `topology.peers` (direct connections) and `topology.tree` (Yggdrasil spanning tree).
2. On a fresh spoke, `topology.tree` contains only `[self, hub-can, hub-usa]`. The other spoke isn't there because Yggdrasil's spanning-tree announcements take time to propagate the new node across the mesh, and no other spoke has yet seen any traffic from this one.
3. So `gatherPeers()` returns `[hub-can, hub-usa]` only. Spoke A's `sub_ad` is sent to the two hubs.
4. The hubs are raw AXL daemons (no axl-pubsub running). They receive the `sub_ad` on their `/recv` queue and never poll, so the messages pile up there indefinitely. No relay happens.
5. Spoke B never receives Spoke A's `sub_ad`. Therefore Spoke B's gossip routing table never gains Spoke A's pubkey, and vice-versa.
6. When Spoke A publishes, `subscribersFor(topic)` returns `[]`. `publish()` returns `sentTo: 0, failed: 0`. Silent no-op.

We confirmed this with a standalone diagnostic (`scripts/test-gossip.ts`) running two `Gossip` instances against the deployed hubs:

- Without direct spoke-spoke peering: `sentTo: 0`, message never received.
- With direct spoke-spoke peering: `sentTo: 1`, message received.

Why the integration test sometimes passed earlier in the project's history: Yggdrasil's spanning tree DOES converge eventually, sometimes including cross-spoke entries. We caught it in a converged window once. After the hubs were restarted (post-DNS work), the tree is sparse again and stays sparse on test horizons.

**Workaround for the integration test:** wire spoke A and spoke B to peer directly with each other in addition to the hubs. The fixture under `/tmp/immunity-spoke-test/` now uses two distinct configs: spoke 1 has `Listen: ["tls://0.0.0.0:9001"]` and exposes its 9001 on the host, spoke 2 dials `tls://host.docker.internal:9101` alongside the two hubs. With direct peering, the integration test passes consistently in ~45s.

**Production gap:** a real spoke joining the network through team hubs does NOT see other spokes. The cold-start problem affects real users too. v2 fix options, listed in increasing scope:

1. **Spoke-side peer discovery:** spokes periodically `GET /topology` against the hubs' HTTP API, learn the pubkeys of all directly-connected peers from there, and seed their gossip target list. Requires either (a) hubs to expose the API publicly (we currently bind to `127.0.0.1` per `bridge_addr`), or (b) a separate hub-side discovery endpoint that doesn't expose the full AXL API.
2. **Hub-side relay (axl-pubsub on hubs):** add Node.js + axl-pubsub to the hub container as a sidecar. Hubs subscribe to the wildcard `**` and re-publish every received message to all other connected peers. Makes hubs proper pubsub overlay nodes.
3. **axl-pubsub upstream feature:** add a `relayMode: boolean` to `Gossip`. When true, on receiving any `sub_ad` or `pub`, the gossip layer forwards it to all other known peers (modulo dedup). Then hubs run a tiny axl-pubsub-with-relayMode and the topology Just Works.

For the demo we accept option 0 (documented limitation) and use the direct-peer test fixture. Filed in `FEEDBACK.md` as an axl-pubsub design gap.

## `verifiability` field in 0G Compute catalog is no longer authoritative

`broker.inference.listService()` exposes a `verifiability` field on each provider entry. Per the spike's FINDINGS (2026-04-21) the chatbot provider `0xa48f01287233509FD694a22Bf840225062E67836` (qwen-2.5-7b-instruct) returned `verifiability: "TeeML"` AND its `verifyService()` call produced two attestation reports (broker + LLM), confirming a Separated TeeML architecture where the LLM itself runs inside a TEE.

As of 2026-04-26 the same call still returns `verifiability: "TeeML"` for that provider, but `verifyService()` now returns:

```js
{
  success: true,
  teeVerifier: "dstack",
  targetSeparated: true,
  reportsGenerated: ["broker"],          // ← only one report; LLM no longer attested
  signerVerification: { ..., allMatch: true },
  composeVerification: { passed: true }
}
```

That is, the broker is still in a TEE and its attestation passes, but the LLM behind it has been moved to a centralized provider. `processResponse(provider, chatId, content)` consequently returns `false` because there is no per-response LLM-TEE signature to verify even though the broker itself is attested.

The other live provider on Galileo (`0x4b2a941929E39Adbea5316dDF2B9Bd8Ff3134389`, qwen-image-edit-2511) is the opposite shape:

```js
{
  ...,
  targetSeparated: false,
  reportsGenerated: ["combined"],        // ← single combined broker+LLM enclave
  signerVerification: { ..., allMatch: true }
}
```

That is the real TeeML: broker and LLM share one enclave. But it's image-editing, not chat completions, so it doesn't fit the SDK's verdict-prompt pipeline.

**What this means:**

- The `verifiability` field in the catalog is no longer a reliable signal for "the LLM is in a TEE." Both providers list "TeeML" but only one actually runs the LLM inside an enclave today.
- For Galileo testnet, the chatbot path is broker-only-TEE. No alternative chatbot with combined attestation exists right now.
- Mainnet has additional models (`qwen3.6-plus`, `GLM-5-FP8`, `deepseek-chat-v3-0324` etc. per the FINDINGS) but they are not deployed on testnet.

**Workaround in the SDK:**

- `src/tee/inference.ts` no longer treats `processResponse() === false` as fatal. It logs a warning naming the chatId and provider, then surfaces `signedAndValid: false` on the `InferenceResult` so policy layers can choose whether to gate on it.
- The broker's own attestation (`verifyService` → `signerVerification.allMatch + composeVerification.passed`) remains the authoritative gate for whether the verdict came from genuine 0G infrastructure. That gate still works.
- When 0G restores LLM-side attestation on this provider (or we point the SDK at a Separated/Combined chatbot provider), the same code path will start receiving `signedAndValid: true` and policy layers can tighten.

**To check whether a provider has full LLM attestation before trusting `verifiability`**, run `verifyService()` and inspect `reportsGenerated`:

- `["broker"]` (with `targetSeparated: true`) means the LLM is centralized despite any TeeML claim in the catalog.
- `["broker", "llm"]` means full Separated TeeML.
- `["combined"]` (with `targetSeparated: false`) means the broker and LLM share one enclave (also full TeeML).
