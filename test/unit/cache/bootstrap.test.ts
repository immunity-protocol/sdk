import { describe, expect, it } from "vitest";
import { bootstrapCacheFromRegistry } from "../../../src/cache/bootstrap.js";
import { AntibodyCache } from "../../../src/cache/cache.js";
import type { ChainAntibody } from "../../../src/settlement/decode.js";
import type { RegistryClient } from "../../../src/settlement/registry-client.js";
import type { Address, Hex32 } from "../../../src/types/antibody.js";

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PUBLISHER: Address = "0x0000000000000000000000000000000000000aaa";

function fakeStruct(seq: number, publisher: string = PUBLISHER): ChainAntibody {
  // ADDRESS antibody, MALICIOUS, ACTIVE — minimal valid struct that
  // decodeAntibody accepts. The fixture shape mirrors what the contract
  // would return via getAntibodyByImmSeq.
  return {
    primaryMatcherHash: `0x${seq.toString(16).padStart(64, "0")}` as Hex32,
    evidenceCid: ZERO_BYTES32,
    contextHash: ZERO_BYTES32,
    embeddingHash: ZERO_BYTES32,
    attestation: ZERO_BYTES32,
    publisher,
    stakeLockUntil: 0n,
    immSeq: BigInt(seq),
    reviewer: PUBLISHER,
    expiresAt: 0n,
    abType: 0n, // ADDRESS
    flavor: 0n,
    verdict: 0n, // MALICIOUS
    confidence: 90n,
    createdAt: 1714000000n,
    stakeAmount: 1_000_000n,
    severity: 80n,
    status: 0n, // ACTIVE
    isSeeded: 0n,
  };
}

interface FakeRegistryConfig {
  total: number;
  /** seqs that should return zero-publisher rows (i.e. gaps). */
  missingSeqs?: Set<number>;
  /** count network calls so we can assert concurrency / skipping. */
  callLog?: { nextImmSeq: number; getAntibodyByImmSeq: number[]; computeKeccakId: number };
}

function fakeRegistry(cfg: FakeRegistryConfig): RegistryClient {
  const log = cfg.callLog ?? { nextImmSeq: 0, getAntibodyByImmSeq: [], computeKeccakId: 0 };
  const contract = {
    async nextImmSeq() {
      log.nextImmSeq++;
      return BigInt(cfg.total);
    },
    async getAntibodyByImmSeq(seq: number | bigint) {
      const n = Number(seq);
      log.getAntibodyByImmSeq.push(n);
      if (cfg.missingSeqs?.has(n)) {
        return fakeStruct(n, ZERO_ADDRESS);
      }
      return fakeStruct(n);
    },
    async computeKeccakId(_a: number, _f: number, primaryMatcherHash: string, _p: string) {
      log.computeKeccakId++;
      // For test simplicity, derive a deterministic keccakId from the
      // matcher hash (the real contract derives via keccak(abi.encode(...))).
      return primaryMatcherHash;
    },
  } as unknown as RegistryClient["contract"];
  return {
    address: "0x0000000000000000000000000000000000000bbb" as Address,
    contract,
    signer: {} as RegistryClient["signer"],
  };
}

describe("bootstrapCacheFromRegistry", () => {
  it("returns zero counts when the registry is empty", async () => {
    const cache = new AntibodyCache();
    const result = await bootstrapCacheFromRegistry(fakeRegistry({ total: 0 }), cache);
    expect(result).toEqual({ total: 0, fetched: 0, skipped: 0, missing: 0 });
    expect(cache.size()).toBe(0);
  });

  it("hydrates the cache with all available antibodies", async () => {
    const cache = new AntibodyCache();
    const result = await bootstrapCacheFromRegistry(fakeRegistry({ total: 5 }), cache);
    expect(result.total).toBe(5);
    expect(result.fetched).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.missing).toBe(0);
    expect(cache.size()).toBe(5);
    for (let i = 1; i <= 5; i++) {
      expect(cache.getByImmSeq(i)).toBeDefined();
    }
  });

  it("skips entries already present in the cache", async () => {
    // Pre-populate seqs 1 and 2.
    const cache = new AntibodyCache();
    const reg = fakeRegistry({ total: 4 });
    // Use bootstrap itself to populate the first 2 entries from the same
    // registry — guarantees keccakId matches what a re-run would produce.
    await bootstrapCacheFromRegistry(reg, cache, { limit: 2 });
    expect(cache.size()).toBe(2);

    const result = await bootstrapCacheFromRegistry(reg, cache);
    expect(result.total).toBe(4);
    // 2 newly fetched (seqs 3, 4); 2 skipped (seqs 1, 2).
    expect(result.fetched).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.missing).toBe(0);
    expect(cache.size()).toBe(4);
  });

  it("counts gaps (zero-publisher rows) as missing without throwing", async () => {
    const cache = new AntibodyCache();
    const reg = fakeRegistry({ total: 5, missingSeqs: new Set([2, 4]) });
    const result = await bootstrapCacheFromRegistry(reg, cache);
    expect(result.total).toBe(5);
    expect(result.fetched).toBe(3); // 1, 3, 5
    expect(result.skipped).toBe(0);
    expect(result.missing).toBe(2); // 2, 4
    expect(cache.size()).toBe(3);
  });

  it("respects a soft limit", async () => {
    const cache = new AntibodyCache();
    const log = { nextImmSeq: 0, getAntibodyByImmSeq: [], computeKeccakId: 0 };
    const reg = fakeRegistry({ total: 100, callLog: log });
    const result = await bootstrapCacheFromRegistry(reg, cache, { limit: 3 });
    expect(result.total).toBe(3);
    expect(result.fetched).toBe(3);
    expect(log.getAntibodyByImmSeq.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("retries transient per-seq failures before giving up", async () => {
    const cache = new AntibodyCache();
    // Registry that fails seq 2 the first two attempts, then succeeds on
    // the third. Mirrors the 0G testnet flake we saw on packed-fleet boot
    // where the same call alternates between CALL_EXCEPTION and a real
    // antibody depending on which read replica handled the request.
    const attempts: Record<number, number> = {};
    const flakyRegistry = {
      address: "0x0000000000000000000000000000000000000bbb" as Address,
      contract: {
        async nextImmSeq() {
          return 3n;
        },
        async getAntibodyByImmSeq(seq: number | bigint) {
          const n = Number(seq);
          attempts[n] = (attempts[n] ?? 0) + 1;
          if (n === 2 && attempts[n] < 3) {
            throw new Error("missing revert data (transient)");
          }
          return fakeStruct(n);
        },
        async computeKeccakId(_a: number, _f: number, primaryMatcherHash: string, _p: string) {
          return primaryMatcherHash;
        },
      },
      signer: {},
    } as unknown as RegistryClient;

    const result = await bootstrapCacheFromRegistry(flakyRegistry, cache, { fetchRetries: 3 });
    expect(result.fetched).toBe(3);
    expect(result.missing).toBe(0);
    expect(attempts[2]).toBe(3); // first call + two retries
  });

  it("does not throw when nextImmSeq itself fails", async () => {
    const cache = new AntibodyCache();
    const reg = {
      address: "0x0000000000000000000000000000000000000bbb" as Address,
      contract: {
        async nextImmSeq() {
          throw new Error("rpc down");
        },
      },
      signer: {},
    } as unknown as RegistryClient;
    const result = await bootstrapCacheFromRegistry(reg, cache);
    expect(result).toEqual({ total: 0, fetched: 0, skipped: 0, missing: 0 });
    expect(cache.size()).toBe(0);
  });
});
