import { type Signer, getBytes, keccak256, toUtf8Bytes } from "ethers";
import type { Address, Hex, Hex32 } from "../types/antibody.js";
import { normalizeAddress } from "../util/address.js";
import { cidToHex32, hex32ToCid } from "./cid.js";
import type { EciesBundle } from "./crypto.js";
import type { PublicEnvelopeV1 } from "./envelope.js";

/**
 * The signed body POSTed to the protocol storage gateway. The gateway verifies
 * it by recomputing `payloadHash` from `payload` (canonical JSON) and
 * recovering the signer from `signature` over that hash, asserting it equals
 * `publisher`. The SDK never holds the Lighthouse key — it only signs + POSTs;
 * the gateway holds the key and pins to IPFS.
 *
 * CONTRACT: pinned jointly with storage-gateway (-app) — this is the SDK's
 * proposed shape; the gateway implements the matching verifier.
 */
export interface GatewayRequestV1 {
  schema: "immunity/gateway-request/v1";
  publisher: Address;
  /** keccak256 of `canonicalJson(payload)`. */
  payloadHash: Hex32;
  /** Unix milliseconds (replay window). */
  timestamp: number;
  /** Random per-request nonce (replay protection). */
  nonce: string;
  /** `signer.signMessage(getBytes(payloadHash))`. */
  signature: Hex;
  payload: GatewayPayloadV1;
}

export interface GatewayPayloadV1 {
  envelope: PublicEnvelopeV1;
  /** Packed ECIES blob (`0x…`) — present only when context was encrypted. */
  encryptedContext?: EciesBundle;
}

/** The gateway's response to a successful write. */
export interface GatewayResponseV1 {
  cid: string;
}

export interface StorageClientOptions {
  /** Signed-POST WRITE base (protocol storage gateway). */
  storageGatewayUrl: string;
  /** Keyless READ base (public IPFS gateway), e.g. ".../ipfs/". */
  lighthouseGateway: string;
  /** SDK wallet used to sign write requests. */
  signer: Signer;
  /** Injectable fetch (tests pass a mock; no real network in the suite). */
  fetchImpl?: typeof fetch;
}

/**
 * Deterministic JSON serialization (recursively sorted keys) so the SDK and
 * the gateway hash byte-identical payloads. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * StorageClient — HTTP-only evidence transport.
 *
 *   WRITE = sign the payload with the SDK wallet and POST to `storageGatewayUrl`.
 *   READ  = keyless GET from `lighthouseGateway` (public IPFS), fail-closed.
 *
 * The SDK imports no Lighthouse key or Lighthouse SDK. The write transport is
 * isolated here so a future swap (e.g. capability-delegated direct upload)
 * touches only this class.
 */
export class StorageClient {
  private readonly storageGatewayUrl: string;
  private readonly lighthouseGateway: string;
  private readonly signer: Signer;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StorageClientOptions) {
    this.storageGatewayUrl = opts.storageGatewayUrl;
    this.lighthouseGateway = opts.lighthouseGateway;
    this.signer = opts.signer;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Sign + POST an evidence envelope (and optional encrypted context) to the
   * storage gateway. Returns the on-chain `evidenceCid` (32-byte digest) plus
   * the raw CID string the gateway pinned.
   */
  async putEvidence(
    envelope: PublicEnvelopeV1,
    encryptedContext?: EciesBundle,
  ): Promise<{ evidenceCid: Hex32; cid: string }> {
    const payload: GatewayPayloadV1 = encryptedContext
      ? { envelope, encryptedContext }
      : { envelope };
    const payloadHash = keccak256(toUtf8Bytes(canonicalJson(payload))) as Hex32;
    const publisher = normalizeAddress(await this.signer.getAddress());
    const signature = (await this.signer.signMessage(getBytes(payloadHash))) as Hex;

    const body: GatewayRequestV1 = {
      schema: "immunity/gateway-request/v1",
      publisher,
      payloadHash,
      timestamp: Date.now(),
      nonce: randomNonce(),
      signature,
      payload,
    };

    const res = await this.fetchImpl(this.joinUrl(this.storageGatewayUrl, "evidence"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`storage gateway write failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as GatewayResponseV1;
    if (!json?.cid) throw new Error("storage gateway response missing cid");
    return { evidenceCid: cidToHex32(json.cid), cid: json.cid };
  }

  /**
   * Keyless GET of a public envelope from the IPFS gateway by raw CID string.
   * Fail-closed: any transport/parse error throws — never returns a fabricated
   * or empty envelope.
   */
  async getEvidence(cid: string): Promise<PublicEnvelopeV1> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.joinUrl(this.lighthouseGateway, cid), { method: "GET" });
    } catch (err) {
      throw new Error(`evidence read failed for ${cid}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(`evidence read failed for ${cid}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as PublicEnvelopeV1;
  }

  /** Keyless GET by on-chain `evidenceCid` (32-byte digest → CIDv1 → fetch). */
  async fetchPublicEnvelope(evidenceCid: Hex32): Promise<PublicEnvelopeV1> {
    return this.getEvidence(hex32ToCid(evidenceCid));
  }

  private joinUrl(base: string, path: string): string {
    return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;
  }
}
