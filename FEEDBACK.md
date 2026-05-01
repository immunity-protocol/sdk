# Feedback for the AXL core product (gensyn-ai/axl) and axl-pubsub library

Untracked file. Items here are friction we hit using AXL as a downstream library, framed as actionable feedback.

## AXL daemon (gensyn-ai/axl @ 9cba555f)

### `bridge_addr` config field is undocumented

`AGENTS.md`'s config table lists `Peers`, `PrivateKeyPath`, `api_port`, `router_addr`, `a2a_addr`, `max_message_size`. It does NOT mention `bridge_addr`, but the parser accepts it and the field controls where the HTTP API binds (`127.0.0.1` vs `0.0.0.0`). Required to be `0.0.0.0` for any Docker setup where the consumer process lives outside the daemon's container.

**Suggestion:** add to the AGENTS.md config table with the explicit guidance that Docker users need `0.0.0.0`.

### `/topology` endpoint shape

The `tree` array returns the full spanning tree, while `peers` is direct connections only. axl-pubsub uses both for `sub_ad` distribution. Documenting the distinction (and noting that a freshly-joined node may take seconds to appear in remote `tree`s) would help library authors.

### Multi-arch official Docker image would unblock distribution

Gensyn doesn't publish official AXL container images. Every downstream has to either:
1. Clone + build the daemon themselves
2. Trust someone else's third-party image

We ended up publishing `ghcr.io/immunity-protocol/axl-hub` for our own use. An official `gensyn/axl:<tag>` (multi-arch amd64+arm64, alpine-based, < 10MB final) would let the ecosystem standardize on a known-good binary instead of every downstream re-pinning.

### Health check endpoint

`/topology` doubles as a liveness probe in our setup, but it's a relatively expensive read (returns the full mesh state). A dedicated `/healthz` returning `{"ok":true}` (or the equivalent) would be friendlier to load balancers and Fly's checks.

### `X-From-Peer-Id` semantics deserve their own doc page

The header is a Yggdrasil-derived prefix of the SENDING DAEMON's public key, with `0xff` padding from the IPv6 truncation. It is NOT the originator-of-the-message identity in any application-layer sense. We see this confusion break gossip libraries; an explicit "what this header is and isn't" doc would prevent the bug class entirely.

### Subscription / interest announcement primitive

For pub/sub overlays like axl-pubsub, every layer above AXL has to reinvent peer-discovery + interest-announcement. AXL providing a thin "broadcast to mesh" or "list peers in tree" primitive would shrink that boilerplate.

## axl-pubsub library

### `X-From-Peer-Id` strict-equality check rejects valid topologies

`Gossip.dispatch` (pre-fix) compared the AXL-layer `X-From-Peer-Id` header against `decoded.from` (the gossip envelope's signer pubkey). These are two different identity layers:

- `X-From-Peer-Id`: a Yggdrasil-derived prefix of the sending AXL daemon
- `decoded.from`: the gossip client's own ed25519 keypair used to sign envelopes

In axl-pubsub's own integration tests they happen to be the same (the test setup uses the AXL daemon's PEM as the gossip client's keypair). In any real deployment where the gossip client lives outside the AXL daemon process (e.g. an SDK in Node + AXL in a sidecar container), they're always different and the strict check rejects every inbound message.

**Fixed in:** `741f3e6` and `fea04e0` of this repo's axl-pubsub working copy. Envelope ed25519 signature is the authoritative authenticity source; the X-From-Peer-Id check is redundant defense-in-depth at best and incorrect at worst.

### Sub_ad timing

When a fresh spoke `subscribe()`s, the first sub_ad broadcasts immediately, but it iterates over `topology.peers` and `topology.tree` as seen at that moment. If the spanning tree hasn't propagated the new spoke to remote nodes yet, the sub_ad can be sent over a route that the receiving daemon hasn't established. Subsequent advertise intervals (30s) recover, but the first propagation is racy.

**Suggestion:** retry sub_ad after a configurable backoff window, or expose a hook so consumers know when the routing fabric has stabilized.

### `loadKeyPairFromPem` could fall back to in-memory keys

Currently `Gossip` requires `keyPair` or `privateKeyPath`. For ephemeral test scenarios and "I just want to gossip something quickly" cases, an option to auto-generate a fresh ephemeral keypair would be friendly. We worked around it in our SDK; reflecting it back into the library would help every consumer.

### `PublishResult.sentTo` is a black box

When `sentTo: []`, the publisher doesn't know whether: nobody is subscribed, the routing table hasn't propagated, the AXL daemon refused, or the sub_ad signature failed verification. Explicit error states (vs an empty success array) would help diagnose silent gossip failures.

### Hub-spoke topologies need a relay primitive

This is a real-world gap we hit in production deployment. With our network shape (two team-operated AXL hubs in `immunity-axl-hub`, every user spoke peers with both hubs, no direct spoke-to-spoke links), spokes never receive each other's `sub_ad` messages on cold start.

Reproduction:

1. Bring up the two team hubs (raw AXL daemons; no axl-pubsub).
2. Bring up two spokes, each with `Peers: [hub-can, hub-usa]` and `Listen: []`.
3. From spoke A, run a `Gossip.publish()` for any topic that spoke B subscribed to.
4. Observe `sentTo: 0`. Spoke B never receives.

Trace: `Advertiser.gatherPeers(topology)` (`src/advertiser.ts`) reads target pubkeys from `topology.peers + topology.tree`. On a fresh spoke, both arrays only contain self + the two hubs; the other spoke isn't yet in the Yggdrasil spanning tree because the tree updates lazily based on traffic. So spoke A's `sub_ad` is sent to hub-can and hub-usa only. The hubs aren't running axl-pubsub, so they don't relay. The `sub_ad` dies in the hubs' `/recv` queues. Spoke A's gossip routing table never learns about spoke B; spoke B's never learns about spoke A.

The Yggdrasil spanning tree DOES eventually expand to include cross-spoke entries, but the convergence window varies (we measured 30s to several minutes), and on cold-start nothing flows. This makes the hub-spoke pattern (the obvious topology for a public network with team-operated bootstrap nodes) operationally unusable without intervention.

**Suggested feature:** a `relayMode: boolean` option on `Gossip`. When true:

- On receiving any decoded `sub_ad`, after the regular table upsert, re-broadcast the same envelope to every known peer except the original sender.
- Same for `pub`: after the regular dispatch to local handlers, forward to every other known subscriber for that topic.
- Standard dedup (`this.dedup.isFresh`) prevents loops.
- Optional rate limit / TTL counter to bound flooding cost.

A hub running a tiny axl-pubsub-with-`relayMode` instance becomes a transparent overlay relay: spokes' `sub_ad`s flow through it to other spokes, sub_ad routing tables converge across the mesh, and `Gossip.publish` works end-to-end without the publisher needing to know every subscriber by pubkey.

Adjacent suggestion: expose a way for a `Gossip` consumer to enumerate subscriptions or peers it's relayed for, so the hub operator can see "this hub is currently mediating subscriptions for N peers across M topics" — useful for monitoring.

We're working around this in our integration test by giving the test spokes direct peering with each other. That's a test fixture, not a production fix — production users hit the same wall.

## Documentation suggestions

- Add a "running gossip out-of-process from the AXL daemon" page. The single most common deployment pattern (sidecar container + library in app process) is the one most likely to surface the X-From-Peer-Id pitfall.
- Document the gossip-client / daemon identity separation explicitly. Right now the library implicitly assumes they share a keypair.
- A "minimum viable mesh" guide showing 2 hubs + N spokes (the bootstrap topology Bitcoin-style networks need) would be welcome.
