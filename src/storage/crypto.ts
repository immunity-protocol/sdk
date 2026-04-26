import { randomBytes } from "node:crypto";
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

export interface EncryptedBundle {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key: Uint8Array;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * AES-256-GCM bundle encryption.
 *
 * Each call generates a fresh 32-byte key and 12-byte IV. The encrypted
 * ciphertext is what gets uploaded to 0G Storage as `contextHash`; the key
 * stays with the publisher (or, in the TEE flow, would be wrapped to an
 * attested public key — deferred to v2 since 0G Compute's testnet brokers
 * do not yet expose an attested encryption pubkey).
 */
export async function encryptBundle(
  plaintext: Uint8Array,
): Promise<EncryptedBundle> {
  const key = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cryptoKey = await subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
  );
  return { ciphertext, iv, key };
}

export async function decryptBundle(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (key.byteLength !== KEY_BYTES) throw new Error(`expected ${KEY_BYTES}-byte key`);
  if (iv.byteLength !== IV_BYTES) throw new Error(`expected ${IV_BYTES}-byte IV`);
  const cryptoKey = await subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext),
  );
}
