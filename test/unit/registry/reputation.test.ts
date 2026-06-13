import { describe, expect, it, vi } from "vitest";
import {
  type RawPublisher,
  type ReputationReads,
  ReputationClient,
} from "../../../src/registry/reputation.js";
import type { Address } from "../../../src/types/antibody.js";

const ADDR = "0x00000000000000000000000000000000000000Ab" as Address;

describe("ReputationClient", () => {
  it("scoreOf returns a bigint (coercing a numeric mock)", async () => {
    const reads: ReputationReads = {
      scoreOf: vi.fn(async () => 4242),
      getPublisher: vi.fn(),
    };
    const client = new ReputationClient(reads);
    const score = await client.scoreOf(ADDR);
    expect(score).toBe(4242n);
    expect(typeof score).toBe("bigint");
    expect(reads.scoreOf).toHaveBeenCalledWith(ADDR);
  });

  it("getPublisher decodes the struct to all-bigint fields", async () => {
    const raw: RawPublisher = {
      score: 1000n,
      maturedCount: 5n,
      challengesWon: 2n,
      slashedCount: 1n,
      genesisGranted: 250n,
    };
    const reads: ReputationReads = {
      scoreOf: vi.fn(),
      getPublisher: vi.fn(async () => raw),
    };
    const client = new ReputationClient(reads);
    const p = await client.getPublisher(ADDR);
    expect(p).toEqual({
      score: 1000n,
      maturedCount: 5n,
      challengesWon: 2n,
      slashedCount: 1n,
      genesisGranted: 250n,
    });
  });
});
