import { describe, expect, it, vi } from "vitest";
import { computeKeccakId } from "../../../src/keccak/id.js";
import { type WriteDeps, publish } from "../../../src/publish/operations.js";
import type { PublishInput } from "../../../src/publish/params.js";
import { auxiliaryKeyFor, primaryMatcherHashFor } from "../../../src/publish/seed.js";
import { getPublicKeyFromPrivate } from "../../../src/storage/crypto.js";
import type { Address, AntibodySeed, Hex32 } from "../../../src/types/antibody.js";
import {
  DuplicateAntibodyError,
  InsufficientBalanceError,
  NotRegisteredError,
} from "../../../src/types/errors.js";
import { TEST_NETWORK } from "../../fixtures/network.js";

const PUBLISHER = "0x0000000000000000000000000000000000000aaa" as Address;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;
const HASH = `0x${"ab".repeat(32)}`;
const EVIDENCE_DIGEST = `0x${"e1".repeat(32)}` as Hex32;
const CONTEXT_DIGEST = `0x${"cc".repeat(32)}` as Hex32;
// A real secp256k1 pubkey so encryptContext runs (the preset key is a placeholder).
const CRE_PUBKEY = getPublicKeyFromPrivate(`0x${"11".repeat(32)}`);

const SEED: AntibodySeed = { abType: "ADDRESS", chainId: TEST_NETWORK.chainId, target: TARGET };
const INPUT: PublishInput = {
  seed: SEED,
  verdict: "MALICIOUS",
  confidence: 90,
  severity: 80,
  reasonSummary: "known drainer",
};

function tx() {
  return { hash: HASH, wait: vi.fn(async () => ({})) };
}

function makeDeps(over: {
  publishImpl?: () => Promise<{ hash: string; wait: () => Promise<unknown> }>;
  withContextHash?: boolean;
  creOraclePublicKey?: string;
} = {}): WriteDeps {
  const putEvidence = vi.fn(async (_env: unknown, enc?: unknown) => ({
    evidenceCid: EVIDENCE_DIGEST,
    ...(enc ? { contextHash: CONTEXT_DIGEST } : {}),
    cids: { evidenceCid: "Qm-evidence", ...(enc ? { contextCid: "Qm-context" } : {}) },
  }));
  return {
    publisher: PUBLISHER,
    network: { ...TEST_NETWORK, creOraclePublicKey: (over.creOraclePublicKey ?? CRE_PUBKEY) as `0x${string}` },
    usdc: { allowance: vi.fn(async () => 0n), approve: vi.fn(async () => tx()) },
    registrar: {
      registrationBond: vi.fn(async () => 0n),
      isRegistered: vi.fn(async () => true),
      registerPublisher: vi.fn(async () => tx()),
      deregister: vi.fn(async () => tx()),
    },
    registry: {
      deposit: vi.fn(async () => tx()),
      withdraw: vi.fn(async () => tx()),
      balances: vi.fn(async () => 0n),
      publish: vi.fn(over.publishImpl ?? (async () => tx())),
      mature: vi.fn(async () => tx()),
      getAntibody: vi.fn(async () => ({ immSeq: 7n, bondAmount: 0n })),
    },
    challengeManager: {
      challengeBondBps: vi.fn(async () => 10_000),
      minChallengeBond: vi.fn(async () => 5_000_000n),
      challenge: vi.fn(async () => tx()),
    },
    storage: { putEvidence },
  };
}

describe("publish pipeline", () => {
  it("uploads evidence and assembles the correct PublishParams (no context)", async () => {
    const deps = makeDeps();
    const out = await publish(deps, INPUT);

    const expectedKeccakId = computeKeccakId(
      "ADDRESS",
      0,
      primaryMatcherHashFor(SEED),
      PUBLISHER,
    );
    expect(out.keccakId).toBe(expectedKeccakId);
    expect(out.immSeq).toBe(7);
    expect(out.evidenceCid).toBe(EVIDENCE_DIGEST);
    expect(out.contextHash).toBeUndefined();
    expect(out.txHash).toBe(HASH);

    // Envelope uploaded with NO encrypted context.
    expect(deps.storage.putEvidence).toHaveBeenCalledOnce();
    const [envelope, enc] = (deps.storage.putEvidence as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(envelope).toMatchObject({ keccakId: expectedKeccakId, abType: "ADDRESS", publisher: PUBLISHER });
    expect(enc).toBeUndefined();

    // PublishParams correct.
    const params = (deps.registry.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params).toMatchObject({
      abType: 0,
      verdict: 0,
      confidence: 90,
      severity: 80,
      primaryMatcherHash: primaryMatcherHashFor(SEED),
      auxiliaryKey: auxiliaryKeyFor(SEED),
      evidenceCid: EVIDENCE_DIGEST,
      contextHash: `0x${"0".repeat(64)}`,
    });
  });

  it("does NOT approve USDC for the publish bond (debited from balance)", async () => {
    const deps = makeDeps();
    await publish(deps, INPUT);
    expect(deps.usdc.approve).not.toHaveBeenCalled();
  });

  it("encrypts context and maps contextCid → contextHash", async () => {
    const deps = makeDeps();
    const out = await publish(deps, { ...INPUT, context: "victim lost 5 ETH to this address" });

    const [, enc] = (deps.storage.putEvidence as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof enc).toBe("string"); // ECIES bundle
    expect(out.contextHash).toBe(CONTEXT_DIGEST);
    const params = (deps.registry.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(params.contextHash).toBe(CONTEXT_DIGEST);
  });

  it("maps AntibodyExists → DuplicateAntibodyError", async () => {
    const deps = makeDeps({
      publishImpl: async () => {
        throw { revert: { name: "AntibodyExists" } };
      },
    });
    await expect(publish(deps, INPUT)).rejects.toBeInstanceOf(DuplicateAntibodyError);
  });

  it("maps NotRegistered → NotRegisteredError", async () => {
    const deps = makeDeps({
      publishImpl: async () => {
        throw { revert: { name: "NotRegistered" } };
      },
    });
    await expect(publish(deps, INPUT)).rejects.toBeInstanceOf(NotRegisteredError);
  });

  it("maps InsufficientBalance → InsufficientBalanceError", async () => {
    const deps = makeDeps({
      publishImpl: async () => {
        throw { revert: { name: "InsufficientBalance" } };
      },
    });
    await expect(publish(deps, INPUT)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});
