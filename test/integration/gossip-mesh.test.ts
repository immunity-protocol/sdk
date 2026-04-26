import "dotenv/config";
import { JsonRpcProvider, Wallet } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
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
  });
  const subscriber = new Immunity({
    wallet: signer,
    network: "testnet",
    axlUrl: SUB_URL!,
    novelThreatPolicy: "trust-cache",
  });

  afterAll(async () => {
    await Promise.allSettled([publisher.stop(), subscriber.stop()]);
  });

  it("publishes on node A and observes on node B within 5s", async () => {
    await Promise.all([publisher.start(), subscriber.start()]);

    const target = randomAddress();
    const pub = await publisher.publish({
      seed: { abType: "ADDRESS", chainId: TESTNET.chainId, target },
      verdict: "MALICIOUS",
      confidence: 90,
      severity: 80,
    });

    // Subscriber's gossip subscription should populate within a few seconds
    // (axl-pubsub default poll interval is 25ms, advertise is 30s but we
    // already advertised on start). Probe locally by seeing if a check
    // against the published target hits the cache.
    const start = Date.now();
    let hit = false;
    while (Date.now() - start < 5_000) {
      const r = await subscriber.check(
        { to: target, chainId: TESTNET.chainId },
        {},
      );
      if (!r.allowed && r.antibodies.some((a) => a.keccakId === pub.keccakId)) {
        hit = true;
        break;
      }
      await sleep(200);
    }
    expect(hit).toBe(true);
  }, 60_000);
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
