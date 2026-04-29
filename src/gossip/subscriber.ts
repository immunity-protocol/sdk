import type { Gossip, ReceivedPub, Subscription } from "axl-pubsub";
import type { AntibodyCache } from "../cache/cache.js";
import type { NegativeMatcherCache } from "../registry/negative-cache.js";
import { createLogger } from "../util/logger.js";
import { decodeAntibody } from "./envelope.js";
import { TOPIC_WILDCARD } from "./topics.js";

const log = createLogger("gossip:subscriber");

/**
 * Bridges incoming gossip messages into the local antibody cache.
 *
 * Decode failures (malformed envelope, bad schema, untrusted bigint)
 * are logged and dropped: a malicious peer broadcasting garbage cannot
 * crash the SDK or pollute the cache.
 *
 * axl-pubsub already verifies the wire signature against the sender's
 * pubkey and de-duplicates by message id, so we only need to worry
 * about payload-level validity here.
 */
export class GossipSubscriber {
  private subscription?: Subscription;

  constructor(
    private readonly gossip: Gossip,
    private readonly cache: AntibodyCache,
    private readonly negativeCache?: NegativeMatcherCache,
  ) {}

  async start(): Promise<void> {
    this.subscription = await this.gossip.subscribe(TOPIC_WILDCARD, (msg) => {
      this.handle(msg);
    });
    log.info("subscribed", TOPIC_WILDCARD);
  }

  async stop(): Promise<void> {
    if (this.subscription) await this.subscription.unsubscribe();
  }

  private handle(msg: ReceivedPub): void {
    try {
      const ab = decodeAntibody(msg.payload);
      this.cache.put(ab);
      // Freshly-published antibodies must become visible immediately, not be
      // hidden behind a stale "absent" entry from a prior Tier-2 miss.
      this.negativeCache?.evict(ab.primaryMatcherHash);
      log.debug("absorbed", { topic: msg.topic, immId: ab.immId, from: msg.from.slice(0, 12) });
    } catch (err) {
      log.warn("decode failed; dropping", {
        topic: msg.topic,
        from: msg.from.slice(0, 12),
        err: (err as Error).message,
      });
    }
  }
}
