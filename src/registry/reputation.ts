import type { Address } from "../types/antibody.js";

/**
 * Typed publisher reputation, mirroring `Reputation.getPublisher`.
 * All counts/scores are `bigint` (the contract returns `uint256`/`uint64`).
 * `genesisGranted` is the cumulative genesis reputation amount granted.
 */
export interface PublisherReputation {
  score: bigint;
  maturedCount: bigint;
  challengesWon: bigint;
  slashedCount: bigint;
  genesisGranted: bigint;
}

type Numeric = bigint | number;

/** Raw struct shape of `Reputation.getPublisher`. */
export interface RawPublisher {
  score: Numeric;
  maturedCount: Numeric;
  challengesWon: Numeric;
  slashedCount: Numeric;
  genesisGranted: Numeric;
}

/** The subset of `Reputation` view methods the SDK reads. */
export interface ReputationReads {
  scoreOf(addr: Address): Promise<Numeric>;
  getPublisher(addr: Address): Promise<RawPublisher>;
}

/**
 * Read-only client over the `Reputation` contract. Used by the explorer and
 * the later `corroborate` policy (S5). The SDK NEVER writes reputation, and the
 * enforcement decision does not recompute it — the chain already rep-floors
 * corroboration; `publisherRep` is display/escalation context only.
 */
export class ReputationClient {
  private readonly reads: ReputationReads;

  constructor(reads: ReputationReads) {
    this.reads = reads;
  }

  async scoreOf(addr: Address): Promise<bigint> {
    return BigInt(await this.reads.scoreOf(addr));
  }

  async getPublisher(addr: Address): Promise<PublisherReputation> {
    const p = await this.reads.getPublisher(addr);
    return {
      score: BigInt(p.score),
      maturedCount: BigInt(p.maturedCount),
      challengesWon: BigInt(p.challengesWon),
      slashedCount: BigInt(p.slashedCount),
      genesisGranted: BigInt(p.genesisGranted),
    };
  }
}
