import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import type { Signer } from "ethers";
import type { Hex32 } from "../types/antibody.js";
import { NetworkError } from "../types/errors.js";

export interface StorageClient {
  uploadBytes(bytes: Uint8Array): Promise<{ rootHash: Hex32; txHash: string }>;
  downloadBytes(rootHash: Hex32): Promise<Uint8Array>;
  uploadJson(value: unknown): Promise<{ rootHash: Hex32; txHash: string }>;
  downloadJson<T = unknown>(rootHash: Hex32): Promise<T>;
}

export interface StorageClientOptions {
  indexerUrl: string;
  rpcUrl: string;
  signer: Signer;
}

/**
 * 0G Storage client.
 *
 * Wraps `@0gfoundation/0g-ts-sdk`'s `Indexer` with byte-level upload/download
 * and JSON convenience methods. RetryOpts use the PascalCase shape the
 * upstream SDK requires (camelCase silently no-ops, per the FINDINGS).
 */
export function createStorageClient(opts: StorageClientOptions): StorageClient {
  const indexer = new Indexer(opts.indexerUrl);

  async function uploadBytes(bytes: Uint8Array): Promise<{ rootHash: Hex32; txHash: string }> {
    const mem = new MemData(bytes);
    // The storage SDK declares its Signer arg against ethers' CJS bundle;
    // we use the ESM bundle. Same runtime class, different declared type
    // identities — cast through `unknown` to bridge.
    const [tx, err] = await indexer.upload(
      mem,
      opts.rpcUrl,
      opts.signer as unknown as Parameters<typeof indexer.upload>[2],
      undefined,
      { Retries: 3, Interval: 5, MaxGasPrice: 0 },
    );
    if (err) throw new NetworkError(`storage upload failed: ${describeError(err)}`, { cause: err });
    if (!tx) throw new NetworkError("storage upload returned no tx");
    const t = tx as
      | { rootHash: string; txHash: string }
      | { rootHashes: string[]; txHashes: string[] };
    const rootHash = "rootHash" in t ? t.rootHash : (t.rootHashes[0] ?? "");
    const txHash = "rootHash" in t ? t.txHash : (t.txHashes[0] ?? "");
    if (!rootHash) throw new NetworkError("storage upload returned empty rootHash");
    return { rootHash: rootHash.toLowerCase() as Hex32, txHash };
  }

  async function downloadBytes(rootHash: Hex32): Promise<Uint8Array> {
    const dir = mkdtempSync(path.join(tmpdir(), "immunity-storage-"));
    const file = path.join(dir, "blob");
    try {
      const err = await indexer.download(rootHash, file, true);
      if (err) {
        throw new NetworkError(
          `storage download failed: ${describeError(err)}`,
          { cause: err as unknown },
        );
      }
      return new Uint8Array(readFileSync(file));
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  async function uploadJson(value: unknown): Promise<{ rootHash: Hex32; txHash: string }> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return uploadBytes(bytes);
  }

  async function downloadJson<T = unknown>(rootHash: Hex32): Promise<T> {
    const bytes = await downloadBytes(rootHash);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  return { uploadBytes, downloadBytes, uploadJson, downloadJson };
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

// Suppress lint: writeFileSync is exported in case the upstream SDK changes
// its download signature back to in-memory; keep the import live.
void writeFileSync;
