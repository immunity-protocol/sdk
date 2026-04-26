import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import type { AntibodyCache } from "../../src/cache/cache.js";
import { Immunity, TESTNET } from "../../src/index.js";

/**
 * Two-node gossip propagation against an externally-managed AXL mesh.
 *
 * Required env:
 *   WALLET_PRIVATE_KEY    - testnet wallet (used by both publisher + subscriber)
 *   AXL_URL_PUBLISHER     - first AXL node (e.g. http://localhost:9002)
 *   AXL_URL_SUBSCRIBER    - second AXL node (e.g. http://localhost:9012)
 *
 * The two SDK instances must talk through SEPARATE AXL nodes for the
 * Gensyn prize requirement to hold.
 */
const WALLET = process.env.WALLET_PRIVATE_KEY;
const PUB_URL = process.env.AXL_URL_PUBLISHER ?? process.env.AXL_URL;
const SUB_URL = process.env.AXL_URL_SUBSCRIBER;
const SHOULD_RUN = Boolean(WALLET) && Boolean(PUB_URL) && Boolean(SUB_URL);

describe.skipIf(!SHOULD_RUN)("two-node gossip propagation", () => {
  const provider = new JsonRpcProvider(TESTNET.rpcUrl);
  const signer = new Wallet(WALLET!, provider);
  const publisher = new Immunity({
    wallet: signer,
    network: "testnet",
    axlUrl: PUB_URL!,
    novelThreatPolicy: "trust-cache",
    ...(process.env.AXL_IDENTITY_PUBLISHER
      ? { axlIdentityPath: process.env.AXL_IDENTITY_PUBLISHER }
      : {}),
  });
  const subscriber = new Immunity({
    wallet: signer,
    network: "testnet",
    axlUrl: SUB_URL!,
    novelThreatPolicy: "trust-cache",
    ...(process.env.AXL_IDENTITY_SUBSCRIBER
      ? { axlIdentityPath: process.env.AXL_IDENTITY_SUBSCRIBER }
      : {}),
  });

  afterAll(async () => {
    await Promise.allSettled([publisher.stop(), subscriber.stop()]);
  });

  it("publishes on node A and observes on node B via cache", async () => {
    await Promise.all([publisher.start(), subscriber.start()]);

    // Let sub_ad propagate across the mesh before publishing. axl-pubsub
    // broadcasts subscription announcements on start; the publisher needs
    // to learn about the subscriber's interest in immunity.antibody.* via
    // the AXL routing fabric before it will fan out.
    await sleep(3_000);

    const target = randomAddress();
    const pub = await publisher.publish({
      seed: { abType: "ADDRESS", chainId: TESTNET.chainId, target },
      verdict: "MALICIOUS",
      confidence: 90,
      severity: 80,
    });

    // Probe the subscriber's local cache directly. Each `check()` would
    // submit a chain settlement and steal the time budget; the cache lookup
    // is free.
    const cache = (
      subscriber as unknown as { ensureStarted: () => { cache: AntibodyCache } }
    ).ensureStarted().cache;

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (cache.has(pub.keccakId)) break;
      await sleep(250);
    }
    expect(cache.has(pub.keccakId)).toBe(true);

    // Cache hit produces a block when the matcher resolves it.
    const r = await subscriber.check({ to: target, chainId: TESTNET.chainId }, {});
    expect(r.allowed).toBe(false);
    expect(r.antibodies.some((a) => a.keccakId === pub.keccakId)).toBe(true);
  }, 90_000);
});

function randomAddress(): `0x${string}` {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
