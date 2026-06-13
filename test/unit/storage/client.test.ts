import { Wallet, getBytes, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { StorageClient, canonicalJson } from "../../../src/storage/client.js";
import { hex32ToCid } from "../../../src/storage/cid.js";
import type { PublicEnvelopeV1 } from "../../../src/storage/envelope.js";
import type { Hex32 } from "../../../src/types/antibody.js";

const WALLET = new Wallet("0x1111111111111111111111111111111111111111111111111111111111111111");
const DIGEST: Hex32 = "0xa5aceef07eedc92df674a78966df6bcb607e5a29144be0a077361e80b8056971";
const GATEWAY_CID = hex32ToCid(DIGEST);
// A distinct digest/CID for the separately-pinned encrypted context object.
const CONTEXT_DIGEST: Hex32 = "0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00";
const CONTEXT_CID = hex32ToCid(CONTEXT_DIGEST);

const ENVELOPE: PublicEnvelopeV1 = {
  schema: "immunity/antibody-envelope/v1",
  keccakId: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  immId: "IMM-1",
  abType: "ADDRESS",
  flavor: 0,
  publisher: WALLET.address as `0x${string}`,
  createdAt: "2026-06-13T00:00:00Z",
  reasonSummary: "known drainer",
  matcher: { kind: "address", chainId: 84532, target: "0x000000000000000000000000000000000000dead" },
};

function makeClient(fetchImpl: typeof fetch) {
  return new StorageClient({
    storageGatewayUrl: "https://gw.test/",
    lighthouseGateway: "https://ipfs.test/ipfs/",
    signer: WALLET,
    fetchImpl,
  });
}

describe("StorageClient.putEvidence (signed POST)", () => {
  it("signs the canonical payload and POSTs the pinned GatewayRequestV1 shape", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      // pinned shape
      expect(body.schema).toBe("immunity/gateway-request/v1");
      expect(body.publisher.toLowerCase()).toBe(WALLET.address.toLowerCase());
      expect(typeof body.timestamp).toBe("number");
      expect(typeof body.nonce).toBe("string");
      // payloadHash matches the canonical hash of the payload
      const expectedHash = keccak256(toUtf8Bytes(canonicalJson(body.payload)));
      expect(body.payloadHash).toBe(expectedHash);
      // signature recovers to the publisher
      const recovered = verifyMessage(getBytes(body.payloadHash), body.signature);
      expect(recovered.toLowerCase()).toBe(WALLET.address.toLowerCase());
      return new Response(JSON.stringify({ evidenceCid: GATEWAY_CID }), { status: 200 });
    });

    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.putEvidence(ENVELOPE);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://gw.test/evidence");
    expect((init as RequestInit).method).toBe("POST");
    expect(out.cids.evidenceCid).toBe(GATEWAY_CID);
    expect(out.evidenceCid).toBe(DIGEST);
    // No context sent → no contextHash / contextCid.
    expect(out.contextHash).toBeUndefined();
    expect(out.cids.contextCid).toBeUndefined();
  });

  it("maps the context CID to contextHash when encrypted context is provided", async () => {
    let captured: unknown;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string).payload;
      return new Response(
        JSON.stringify({ evidenceCid: GATEWAY_CID, contextCid: CONTEXT_CID }),
        { status: 200 },
      );
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const out = await client.putEvidence(ENVELOPE, "0xdeadbeef" as `0x${string}`);
    expect((captured as { encryptedContext?: string }).encryptedContext).toBe("0xdeadbeef");
    expect(out.evidenceCid).toBe(DIGEST);
    expect(out.contextHash).toBe(CONTEXT_DIGEST);
    expect(out.cids.contextCid).toBe(CONTEXT_CID);
  });

  it("throws when the gateway returns a non-ok status", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.putEvidence(ENVELOPE)).rejects.toThrow(/write failed/);
  });
});

describe("StorageClient read (keyless GET, fail-closed)", () => {
  it("GETs keyless from the IPFS gateway by CID", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://ipfs.test/ipfs/${GATEWAY_CID}`);
      return new Response(JSON.stringify(ENVELOPE), { status: 200 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const env = await client.getEvidence(GATEWAY_CID);
    expect(env.immId).toBe("IMM-1");
  });

  it("fetchPublicEnvelope maps evidenceCid -> CID before GET", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://ipfs.test/ipfs/${GATEWAY_CID}`);
      return new Response(JSON.stringify(ENVELOPE), { status: 200 });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const env = await client.fetchPublicEnvelope(DIGEST);
    expect(env.keccakId).toBe(ENVELOPE.keccakId);
  });

  it("fails closed on a non-ok read (never fabricates an envelope)", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.getEvidence(GATEWAY_CID)).rejects.toThrow(/read failed/);
  });

  it("fails closed on a transport error", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.getEvidence(GATEWAY_CID)).rejects.toThrow(/read failed/);
  });
});
