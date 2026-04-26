import { keccak256 } from "ethers";
import type { Hex32 } from "../types/antibody.js";
import { type EncryptedBundle, encryptBundle } from "./crypto.js";
import type { StorageClient } from "./indexer.js";

export interface ContextUpload {
  contextHash: Hex32;
  txHash: string;
  /**
   * The randomly generated AES key used to encrypt the bundle. Caller
   * decides retention policy: discard for write-only audit trails, or
   * persist alongside antibody metadata for future decryption.
   */
  key: Uint8Array;
  iv: Uint8Array;
}

/**
 * Encrypt the distilled context bundle, prepend the 12-byte IV to the
 * ciphertext, and upload the resulting blob to 0G Storage. Returns the
 * Merkle root hash as `contextHash` and the ephemeral key/IV.
 */
export async function uploadEncryptedContext(
  storage: StorageClient,
  plaintext: Uint8Array,
): Promise<ContextUpload> {
  const sealed = await encryptBundle(plaintext);
  const blob = packEncrypted(sealed);
  const { rootHash, txHash } = await storage.uploadBytes(blob);
  return { contextHash: rootHash, txHash, key: sealed.key, iv: sealed.iv };
}

/**
 * Wire format for encrypted uploads:
 *
 *   [12 bytes IV][ciphertext (AES-GCM, includes 16-byte auth tag at end)]
 *
 * Concatenated so a single download yields both the IV and the ciphertext.
 * The key is NOT part of the blob; the publisher retains it (or wraps it
 * out of band) so only authorized parties can decrypt.
 */
function packEncrypted(b: EncryptedBundle): Uint8Array {
  const out = new Uint8Array(b.iv.byteLength + b.ciphertext.byteLength);
  out.set(b.iv, 0);
  out.set(b.ciphertext, b.iv.byteLength);
  return out;
}

export function unpackEncrypted(blob: Uint8Array): { iv: Uint8Array; ciphertext: Uint8Array } {
  if (blob.byteLength < 12) throw new Error("encrypted blob shorter than 12-byte IV");
  return { iv: blob.slice(0, 12), ciphertext: blob.slice(12) };
}

/**
 * Convenience: hash the public envelope locally to derive the `evidenceCid`
 * the SDK records on-chain. Identical to `keccak256(jsonBytes)` so that
 * any party who downloads the public envelope can verify integrity by
 * re-hashing.
 *
 * Note: the storage upload returns the actual Merkle root, not the keccak.
 * This helper exists for offline verification only.
 */
export function publicEnvelopeKeccak(value: unknown): Hex32 {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return keccak256(bytes) as Hex32;
}
