import { describe, expect, it, vi } from "vitest";
import { Tier2LookupClient, computeCandidateMatcherHashes } from "../../../src/registry/lookup.js";
import { NegativeMatcherCache } from "../../../src/registry/negative-cache.js";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import type { RegistryClient } from "../../../src/settlement/registry-client.js";
import type { Address, Hex32 } from "../../../src/types/antibody.js";

const TARGET = "0x8589427373d6d84e98730d7795d8f6f8731fda16" as Address;
const PUBLISHER = "0x4789ddae13d7cbf11aa97d39b201d973d01cbc28" as Address;
const CHAIN_ID = 16602;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function chainAntibody(matcherHash: Hex32, publisher: Address) {
  return {
    primaryMatcherHash: matcherHash,
    evidenceCid: ZERO_BYTES32,
    contextHash: ZERO_BYTES32,
    embeddingHash: ZERO_BYTES32,
    attestation: ZERO_BYTES32,
    publisher,
    stakeLockUntil: 0n,
    immSeq: 1n,
    reviewer: publisher,
    expiresAt: 0n,
    abType: 0n,
    flavor: 0n,
    verdict: 0n,
    confidence: 90n,
    createdAt: 1_700_000_000n,
    stakeAmount: 1_000_000n,
    severity: 75n,
    status: 0n,
    isSeeded: 0n,
  };
}

function makeRegistry(opts: {
  byMatcher?: (hash: string) => { antibody: ReturnType<typeof chainAntibody>; exists: boolean };
  matcherIndex?: (hash: string) => string;
}): RegistryClient {
  return {
    address: ZERO_ADDRESS,
    contract: {
      getAntibodyByMatcherHash: vi.fn(async (hash: string) =>
        opts.byMatcher?.(hash) ?? {
          antibody: chainAntibody(ZERO_BYTES32, ZERO_ADDRESS),
          exists: false,
        },
      ),
      matcherIndex: vi.fn(async (hash: string) => opts.matcherIndex?.(hash) ?? ZERO_BYTES32),
    } as unknown as RegistryClient["contract"],
    signer: {} as RegistryClient["signer"],
  };
}

describe("Tier2LookupClient.getAntibodyByMatcherHash", () => {
  it("returns the antibody when the chain reports exists=true", async () => {
    const matcherHash = hashAddressMatcher({ chainId: CHAIN_ID, target: TARGET });
    const fakeKeccakId = `0x${"de".repeat(32)}` as Hex32;

    const registry = makeRegistry({
      byMatcher: () => ({ antibody: chainAntibody(matcherHash, PUBLISHER), exists: true }),
      matcherIndex: () => fakeKeccakId,
    });
    const client = new Tier2LookupClient(registry, CHAIN_ID);

    const result = await client.getAntibodyByMatcherHash(matcherHash);
    expect(result.exists).toBe(true);
    expect(result.antibody?.publisher).toBe(PUBLISHER);
    expect(result.antibody?.keccakId).toBe(fakeKeccakId);
    expect(result.antibody?.confidence).toBe(90);
  });

  it("marks the matcher as absent in the negative cache after a miss", async () => {
    const matcherHash = `0x${"a1".repeat(32)}` as Hex32;
    const negativeCache = new NegativeMatcherCache();
    const registry = makeRegistry({});
    const client = new Tier2LookupClient(registry, CHAIN_ID, negativeCache);

    const result = await client.getAntibodyByMatcherHash(matcherHash);
    expect(result.exists).toBe(false);
    expect(negativeCache.isCachedAsAbsent(matcherHash)).toBe(true);
  });

  it("short-circuits when the negative cache already says absent", async () => {
    const matcherHash = `0x${"a2".repeat(32)}` as Hex32;
    const negativeCache = new NegativeMatcherCache();
    negativeCache.markAbsent(matcherHash);

    const byMatcherSpy = vi.fn();
    const registry = makeRegistry({ byMatcher: byMatcherSpy });
    const client = new Tier2LookupClient(registry, CHAIN_ID, negativeCache);

    const result = await client.getAntibodyByMatcherHash(matcherHash);
    expect(result.exists).toBe(false);
    expect(byMatcherSpy).not.toHaveBeenCalled();
  });

  it("does not cache absent when the chain returned exists=true", async () => {
    const matcherHash = `0x${"a3".repeat(32)}` as Hex32;
    const negativeCache = new NegativeMatcherCache();
    const fakeKeccakId = `0x${"ab".repeat(32)}` as Hex32;

    const registry = makeRegistry({
      byMatcher: () => ({ antibody: chainAntibody(matcherHash, PUBLISHER), exists: true }),
      matcherIndex: () => fakeKeccakId,
    });
    const client = new Tier2LookupClient(registry, CHAIN_ID, negativeCache);

    await client.getAntibodyByMatcherHash(matcherHash);
    expect(negativeCache.isCachedAsAbsent(matcherHash)).toBe(false);
  });
});

describe("Tier2LookupClient.firstMatch", () => {
  it("probes tx.to and stops at the first hit", async () => {
    const expectedHash = hashAddressMatcher({ chainId: CHAIN_ID, target: TARGET });
    const fakeKeccakId = `0x${"cd".repeat(32)}` as Hex32;

    let calls = 0;
    const registry = makeRegistry({
      byMatcher: (hash) => {
        calls++;
        if (hash === expectedHash) {
          return { antibody: chainAntibody(expectedHash, PUBLISHER), exists: true };
        }
        return { antibody: chainAntibody(ZERO_BYTES32, ZERO_ADDRESS), exists: false };
      },
      matcherIndex: () => fakeKeccakId,
    });
    const client = new Tier2LookupClient(registry, CHAIN_ID);

    const ab = await client.firstMatch({ to: TARGET, chainId: CHAIN_ID }, {});
    expect(ab?.publisher).toBe(PUBLISHER);
    expect(calls).toBe(1);
  });

  it("returns null when no candidate hash matches", async () => {
    const registry = makeRegistry({});
    const client = new Tier2LookupClient(registry, CHAIN_ID);
    const ab = await client.firstMatch({ to: TARGET, chainId: CHAIN_ID }, {});
    expect(ab).toBeNull();
  });

  it("returns null for an empty tx and context", async () => {
    const registry = makeRegistry({});
    const client = new Tier2LookupClient(registry, CHAIN_ID);
    const ab = await client.firstMatch(null, {});
    expect(ab).toBeNull();
  });
});

describe("computeCandidateMatcherHashes", () => {
  it("yields tx.to as an ADDRESS hash when set", () => {
    const hashes = computeCandidateMatcherHashes(
      { to: TARGET, chainId: CHAIN_ID },
      {},
      CHAIN_ID,
    );
    expect(hashes).toEqual([hashAddressMatcher({ chainId: CHAIN_ID, target: TARGET })]);
  });

  it("dedups across tx.to and counterparty.id", () => {
    const hashes = computeCandidateMatcherHashes(
      { to: TARGET, chainId: CHAIN_ID },
      { counterparty: { id: TARGET } },
      CHAIN_ID,
    );
    expect(hashes).toHaveLength(1);
  });

  it("falls back to defaultChainId when tx.chainId is absent", () => {
    const fallbackChainId = 1;
    const hashes = computeCandidateMatcherHashes(
      { to: TARGET },
      {},
      fallbackChainId,
    );
    expect(hashes).toEqual([hashAddressMatcher({ chainId: fallbackChainId, target: TARGET })]);
  });

  it("ignores non-address counterparty ids", () => {
    const hashes = computeCandidateMatcherHashes(
      null,
      { counterparty: { id: "alice@example.com" } },
      CHAIN_ID,
    );
    expect(hashes).toEqual([]);
  });
});
