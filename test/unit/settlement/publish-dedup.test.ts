import { describe, expect, it, vi } from "vitest";
import { type PublishInput, publish } from "../../../src/settlement/publish.js";
import type { StorageClient } from "../../../src/storage/indexer.js";
import { Tier2LookupClient } from "../../../src/registry/lookup.js";
import type { RegistryClient } from "../../../src/settlement/registry-client.js";
import { MatcherAlreadyClaimedError } from "../../../src/types/errors.js";
import type { Address, AntibodySeed, Hex32 } from "../../../src/types/antibody.js";

const PUBLISHER = "0x4789DDAE13d7CbF11AA97D39b201d973D01CBc28" as Address;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const SEED: AntibodySeed = {
  abType: "ADDRESS",
  chainId: 16602,
  target: "0x8589427373d6d84e98730d7795d8f6f8731fda16" as Address,
};

const INPUT: PublishInput = {
  seed: SEED,
  verdict: "MALICIOUS",
  confidence: 90,
  severity: 80,
  reasonSummary: "OFAC SDN address",
};

function makeStorage(): StorageClient {
  let counter = 1;
  return {
    async uploadBytes() {
      return { rootHash: `0x${(counter++).toString(16).padStart(64, "0")}` as Hex32, txHash: "tx" };
    },
    async uploadJson() {
      return { rootHash: `0x${(counter++).toString(16).padStart(64, "0")}` as Hex32, txHash: "tx" };
    },
    async downloadBytes() {
      throw new Error("not used");
    },
    async downloadJson() {
      throw new Error("not used");
    },
  };
}

function antibodyStruct(matcherHash: Hex32, publisher: Address) {
  return {
    primaryMatcherHash: matcherHash,
    evidenceCid: ZERO_BYTES32,
    contextHash: ZERO_BYTES32,
    embeddingHash: ZERO_BYTES32,
    attestation: ZERO_BYTES32,
    publisher,
    stakeLockUntil: 0n,
    immSeq: 7n,
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

function fakeRegistryWithExistingMatcher(existingKeccakId: Hex32): RegistryClient {
  return {
    address: ZERO_ADDRESS,
    contract: {
      publish: vi.fn(),
      getAntibodyByMatcherHash: vi.fn(async (hash: string) => ({
        antibody: antibodyStruct(hash as Hex32, PUBLISHER),
        exists: true,
      })),
      matcherIndex: vi.fn(async () => existingKeccakId),
      interface: { parseError: () => null, parseLog: () => null },
    } as unknown as RegistryClient["contract"],
    signer: {} as RegistryClient["signer"],
  };
}

function fakeRegistryWithRevert(errorData: string): RegistryClient {
  const publishFn = vi.fn(async () => {
    const err = Object.assign(new Error("execution reverted"), {
      data: errorData,
    });
    throw err;
  });
  return {
    address: ZERO_ADDRESS,
    contract: {
      publish: publishFn,
      getAntibodyByMatcherHash: vi.fn(async () => ({
        antibody: antibodyStruct(ZERO_BYTES32, ZERO_ADDRESS),
        exists: false,
      })),
      matcherIndex: vi.fn(async () => ZERO_BYTES32),
      interface: {
        parseError: vi.fn((data: string) => {
          if (data === errorData) {
            return {
              name: "AntibodyAlreadyExistsForMatcher",
              args: [`0x${"ee".repeat(32)}`],
            };
          }
          return null;
        }),
        parseLog: () => null,
      },
    } as unknown as RegistryClient["contract"],
    signer: {} as RegistryClient["signer"],
  };
}

describe("publish() dedup integration", () => {
  it("preflight: throws MatcherAlreadyClaimedError without sending a tx", async () => {
    const existingKeccakId = `0x${"de".repeat(32)}` as Hex32;
    const registry = fakeRegistryWithExistingMatcher(existingKeccakId);
    const lookup = new Tier2LookupClient(registry, 16602);

    await expect(publish(registry, makeStorage(), PUBLISHER, INPUT, lookup)).rejects.toThrow(
      MatcherAlreadyClaimedError,
    );
    expect(registry.contract.publish).not.toHaveBeenCalled();
  });

  it("preflight: surfaces the existing keccakId on the typed error", async () => {
    const existingKeccakId = `0x${"ab".repeat(32)}` as Hex32;
    const registry = fakeRegistryWithExistingMatcher(existingKeccakId);
    const lookup = new Tier2LookupClient(registry, 16602);

    try {
      await publish(registry, makeStorage(), PUBLISHER, INPUT, lookup);
      throw new Error("expected publish to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MatcherAlreadyClaimedError);
      expect((err as MatcherAlreadyClaimedError).existingKeccakId).toBe(existingKeccakId);
    }
  });

  it("revert path: catches AntibodyAlreadyExistsForMatcher and decodes existing keccakId", async () => {
    // Simulated revert data — the parseError stub above translates this to the named error.
    const revertData = "0xdeadbeef";
    const registry = fakeRegistryWithRevert(revertData);

    await expect(publish(registry, makeStorage(), PUBLISHER, INPUT)).rejects.toThrow(
      MatcherAlreadyClaimedError,
    );
  });

  it("works without a lookup client (preflight is skipped, contract is the safeguard)", async () => {
    const revertData = "0xdeadbeef";
    const registry = fakeRegistryWithRevert(revertData);
    // No `lookup` argument — should still translate the revert.
    await expect(publish(registry, makeStorage(), PUBLISHER, INPUT)).rejects.toThrow(
      MatcherAlreadyClaimedError,
    );
  });
});
