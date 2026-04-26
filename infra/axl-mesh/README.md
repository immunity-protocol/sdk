# AXL mesh

Two-node Gensyn AXL mesh that the Immunity SDK examples and integration tests connect to. Two nodes is the minimum that satisfies the Gensyn prize requirement of cross-node propagation; you can add a third hub by copying `bob` and bumping the host port.

```
agents          host port      container port    role
─────           ─────────      ──────────────    ────
alice           9002           9002              hub, listens on tls://0.0.0.0:9001
bob             9012           9002              dials alice
```

The SDK connects to either node via `axlUrl`. Two SDK instances pointing at different host ports demonstrate true cross-node gossip (not in-process pubsub).

## Prerequisites

- Docker + Docker Compose
- An AXL daemon image tagged `axl-pubsub-axl:local`. The `axl-pubsub` repo's integration test bundles the upstream AXL source as a git submodule and provides a Dockerfile; the simplest way to materialize the image is:

  ```sh
  git clone https://github.com/ophelios-studio/axl-pubsub /tmp/axl-pubsub
  cd /tmp/axl-pubsub
  git submodule update --init --recursive   # pulls the AXL upstream submodule
  cd test/integration/compose
  docker compose build                       # produces axl-pubsub-axl:local
  ```

  The image then exists on the local Docker daemon for the rest of this mesh.

## Bring up

```sh
cd infra/axl-mesh
make keys     # generates ed25519 PEMs in ./keys (gitignored)
make up
```

Verify both nodes are healthy:

```sh
curl -s localhost:9002/peers | head     # alice
curl -s localhost:9012/peers | head     # bob, should list alice
```

## Tear down

```sh
make down       # keeps keys
make clean      # also wipes keys
```

## Pointing the SDK at the mesh

```ts
const a = new Immunity({ wallet, axlUrl: "http://localhost:9002", ... });
const b = new Immunity({ wallet, axlUrl: "http://localhost:9012", ... });
```

Publishing on one instance gossips to the other within ~hundred ms via AXL's TLS link between containers.

## Why external-only?

The SDK refuses to start without `axlUrl`. There is no in-process pubsub fallback. Reasons:

- Gensyn AXL prize judging requires demonstrable cross-node communication.
- Bundling daemon-management into the SDK fights the `axl-pubsub` library's design (which itself is `axlUrl` configured).
- Running daemons inside an npm package complicates packaging, security, and platform support.

Operators are expected to manage the AXL daemon as ops infrastructure: this compose template is a good starting point.
