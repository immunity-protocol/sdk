import type { Gossip, PublishResult } from "axl-pubsub";
import type { Antibody } from "../types/antibody.js";
import { createLogger } from "../util/logger.js";
import { encodeAntibody } from "./envelope.js";
import { topicFor } from "./topics.js";

const log = createLogger("gossip:publisher");

/**
 * Gossip an antibody to the AXL mesh on the topic matching its type.
 *
 * Called by the SDK immediately after a successful on-chain publish or
 * when the SDK auto-republishes a TEE-sourced antibody. The on-chain
 * receipt is the source of truth; gossip is just a low-latency cache
 * primer for peers.
 */
export class GossipPublisher {
  constructor(private readonly gossip: Gossip) {}

  async announce(antibody: Antibody): Promise<PublishResult> {
    const topic = topicFor(antibody.abType);
    const payload = encodeAntibody(antibody);
    const result = await this.gossip.publish(topic, payload);
    log.info("announced", {
      topic,
      immId: antibody.immId,
      sentTo: result.sentTo.length,
      failed: result.failed.length,
    });
    return result;
  }
}
