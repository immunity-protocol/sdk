# Integration test mesh fixture

Two-spoke fixture for the live-network integration tests. Both spokes peer with the deployed team hubs (yyz + ewr) AND directly with each other. The direct peer link is a workaround for the cold-start gossip propagation gap explained in `CHALLENGES.md` and proposed as an upstream feature in `FEEDBACK.md`.

## Bring up

```sh
bash test/fixtures/axl-test-mesh/up.sh
```

That builds nothing; it just docker-runs `local/axl-hub:test` (which you should have built once via `cd ../immunity-axl-hub && docker build -f Dockerfile.axl -t local/axl-hub:test .`).

The script prints the env exports the integration tests need.

## Why direct peering

In the deployed topology, every spoke peers with both hubs. Hubs are raw AXL daemons (no axl-pubsub), so they don't relay `sub_ad` messages between spokes. axl-pubsub's `Advertiser.gatherPeers()` reads from `topology.peers + topology.tree`, which on cold-start contains only `[self, hub-can, hub-usa]` — no other spokes. So sub_ads sent through the hubs die in `/recv` queues, and spoke A's gossip routing table never learns about spoke B.

Direct peering bypasses the issue: each spoke sees the other as a `topology.peers` entry, so sub_ads flow directly. This is purely a test fixture; production spokes shouldn't be expected to peer directly. See FEEDBACK.md for the proposed `relayMode` upstream feature that would let hubs become transparent relays.

## Files

- `spoke1.json`: spoke 1 listens on 9001, dials both hubs.
- `spoke2.json`: spoke 2 dials both hubs + `host.docker.internal:9101` (which the up.sh maps to spoke 1's 9001).
- `up.sh`: idempotent docker bouncer + identity copy.
