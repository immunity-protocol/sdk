import { describe, expect, it } from "vitest";
import { type PublishInput, publish } from "../../../src/settlement/publish.js";
import type { PublicEnvelopeV1 } from "../../../src/storage/envelope.js";
import type { StorageClient } from "../../../src/storage/indexer.js";
import type { Address, AntibodySeed, Hex32 } from "../../../src/types/antibody.js";

const PUBLISHER = "0x4789DDAE13d7CbF11AA97D39b201d973D01CBc28" as Address;
const FAKE_TX = "0xdeadbeef" as Hex32;
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;

interface UploadCall {
  bytes: Uint8Array | null;
  json: unknown;
}

function makeStorage(): { storage: StorageClient; uploads: UploadCall[] } {
  const uploads: UploadCall[] = [];
  let counter = 1;
  const nextRoot = (): Hex32 => {
    const n = counter++;
    return `0x${n.toString(16).padStart(64, "0")}` as Hex32;
  };
  const storage: StorageClient = {
    async uploadBytes(bytes) {
      uploads.push({ bytes, json: null });
      return { rootHash: nextRoot(), txHash: "tx-bytes" };
    },
    async uploadJson(value) {
      uploads.push({ bytes: null, json: value });
      return { rootHash: nextRoot(), txHash: "tx-json" };
    },
    async downloadBytes() {
      throw new Error("not used");
    },
    async downloadJson() {
      throw new Error("not used");
    },
  };
  return { storage, uploads };
}

interface CapturedTx {
  params: Record<string, unknown>;
}

function makeRegistry(captured: CapturedTx): {
  contract: {
    publish: (
      params: Record<string, unknown>,
    ) => Promise<{ wait: () => Promise<{ logs: []; hash: Hex32 }> }>;
    interface: { parseLog: () => null };
  };
} {
  return {
    contract: {
      publish: async (params: Record<string, unknown>) => {
        captured.params = params;
        return {
          wait: async () => ({ logs: [], hash: FAKE_TX }),
          hash: FAKE_TX,
        } as unknown as { wait: () => Promise<{ logs: []; hash: Hex32 }> };
      },
      interface: { parseLog: () => null },
    },
  };
}

const inputBase = {
  verdict: "MALICIOUS" as const,
  confidence: 90,
  severity: 80,
  reasonSummary: "OFAC SDN address",
};

describe("publish (envelope-aware)", () => {
  it("uploads a public envelope and threads evidenceCid into params", async () => {
    const seed: AntibodySeed = {
      abType: "ADDRESS",
      chainId: 16602,
      target: "0x8589427373d6d84e98730d7795d8f6f8731fda16" as Address,
    };
    const { storage, uploads } = makeStorage();
    const captured: CapturedTx = { params: {} };
    const registry = makeRegistry(captured);

    const result = await publish(
      registry as unknown as Parameters<typeof publish>[0],
      storage,
      PUBLISHER,
      { ...inputBase, seed } satisfies PublishInput,
    );

    expect(uploads).toHaveLength(1);
    const env = uploads[0]?.json as PublicEnvelopeV1;
    expect(env.schema).toBe("immunity/antibody-envelope/v1");
    expect(env.abType).toBe("ADDRESS");
    expect(env.reasonSummary).toBe("OFAC SDN address");
    expect(env.matcher).toEqual({
      kind: "address",
      chainId: 16602,
      target: "0x8589427373d6d84e98730d7795d8f6f8731fda16",
    });
    expect(result.evidenceCid).toBe(
      env.keccakId === ""
        ? ""
        : "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(captured.params.evidenceCid).toBe(result.evidenceCid);
    expect(captured.params.contextHash).toBe(ZERO);
    expect(result.contextHash).toBeUndefined();
  });

  it("encrypts and uploads evidence when provided, populating contextHash", async () => {
    const seed: AntibodySeed = {
      abType: "ADDRESS",
      chainId: 16602,
      target: "0x8589427373d6d84e98730d7795d8f6f8731fda16" as Address,
    };
    const { storage, uploads } = makeStorage();
    const captured: CapturedTx = { params: {} };
    const registry = makeRegistry(captured);

    const evidence = new TextEncoder().encode(JSON.stringify({ source: "ofac_sdn" }));
    const result = await publish(
      registry as unknown as Parameters<typeof publish>[0],
      storage,
      PUBLISHER,
      { ...inputBase, seed, evidence } satisfies PublishInput,
    );

    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.json).toBeTruthy();
    expect(uploads[1]?.bytes).toBeInstanceOf(Uint8Array);
    // [12-byte IV][ciphertext+tag]
    expect((uploads[1]?.bytes as Uint8Array).byteLength).toBeGreaterThan(12);
    expect(result.evidenceCid).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(result.contextHash).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
    expect(captured.params.contextHash).toBe(result.contextHash);
  });

  it("derives matcher summary correctly per AntibodySeed type", async () => {
    const cases: { seed: AntibodySeed; expected: Record<string, unknown> }[] = [
      {
        seed: {
          abType: "CALL_PATTERN",
          chainId: 16602,
          target: "0x098b716b8aaf21512996dc57eb0615e2383e2f96" as Address,
          selector: "0x095ea7b3" as Hex32,
          argsTemplate: "0x" as Hex32,
        },
        expected: {
          kind: "call_pattern",
          chainId: 16602,
          target: "0x098b716b8aaf21512996dc57eb0615e2383e2f96",
          selector: "0x095ea7b3",
        },
      },
      {
        seed: {
          abType: "BYTECODE",
          bytecodeHash:
            "0x9c4f8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f" as Hex32,
        },
        expected: {
          kind: "bytecode",
          bytecodeHash: "0x9c4f8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f",
        },
      },
      {
        seed: {
          abType: "SEMANTIC",
          flavor: "PROMPT_INJECTION",
          pattern: { kind: "marker", value: "ignore previous instructions" },
        },
        expected: {
          kind: "semantic",
          flavor: "PROMPT_INJECTION",
          markerHint: "ignore previous instructions",
        },
      },
    ];

    for (const c of cases) {
      const { storage, uploads } = makeStorage();
      const captured: CapturedTx = { params: {} };
      const registry = makeRegistry(captured);
      await publish(registry as unknown as Parameters<typeof publish>[0], storage, PUBLISHER, {
        ...inputBase,
        seed: c.seed,
      } satisfies PublishInput);
      const env = uploads[0]?.json as PublicEnvelopeV1;
      expect(env.matcher).toEqual(c.expected);
    }
  });

  it("skips envelope upload when caller pre-supplies evidenceCid", async () => {
    const seed: AntibodySeed = {
      abType: "ADDRESS",
      chainId: 16602,
      target: "0x8589427373d6d84e98730d7795d8f6f8731fda16" as Address,
    };
    const { storage, uploads } = makeStorage();
    const captured: CapturedTx = { params: {} };
    const registry = makeRegistry(captured);

    const preCid = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface" as Hex32;
    const result = await publish(
      registry as unknown as Parameters<typeof publish>[0],
      storage,
      PUBLISHER,
      { ...inputBase, seed, evidenceCid: preCid } satisfies PublishInput,
    );

    expect(uploads).toHaveLength(0);
    expect(result.evidenceCid).toBe(preCid);
    expect(captured.params.evidenceCid).toBe(preCid);
  });
});
