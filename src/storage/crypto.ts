import { getPublicKey, getSharedSecret, utils } from "@noble/secp256k1";
// @ts-ignore - noble v2 uses subpath exports with .js extension
import { gcm } from "@noble/ciphers/aes.js";
// @ts-ignore - noble v2 uses subpath exports with .js extension
import { sha256 } from "@noble/hashes/sha2.js";
import type { Hex } from "../types/antibody.js";

/**
 * ECIES to the CRE oracle public key — ported VERBATIM from the proven
 * `enshell-sdk/src/crypto.ts` (`encryptForOracle`/`decryptAsOracle`), renamed
 * to `encryptContext`/`decryptContext`. Pure noble primitives only (no
 * `node:crypto`, no `crypto-js`) so the SAME module runs in Node, browsers,
 * and the CRE WASM/QuickJS sandbox. This is the one piece of code shared
 * across the SDK↔CRE boundary, so the wire format MUST stay byte-identical to
 * the CRE decrypt at `enshell-cre-workflow/firewall-analyzer/workflow.ts`.
 *
 * This fixes security finding L-3: the evidence context is no longer
 * encrypted under a random key that gets discarded; it is recoverable ONLY
 * inside the CRE TEE which holds the oracle private key (Chainlink Vault DON).
 *
 * Encryption flow:
 *   1. Generate ephemeral secp256k1 keypair
 *   2. ECDH with recipient's public key → shared secret
 *   3. SHA-256(shared secret) → AES-256-GCM key  (plain SHA-256, NOT HKDF)
 *   4. Encrypt plaintext with AES-256-GCM
 *   5. Output: 0x || ephemeralPublic(33) || nonce(12) || ciphertext(tag included)
 */

/**
 * The packed ECIES wire blob, as a single `0x…` hex string. Layout:
 *   ephemeralPublic(33, compressed secp256k1) || nonce(12) || ciphertext+tag.
 * This IS the serialization the CRE decrypt consumes — there is no separate
 * structured envelope.
 */
export type EciesBundle = Hex;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace("0x", "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypt a plaintext string to the CRE oracle's secp256k1 public key.
 * The oracle's public key lives in network config (safe to ship publicly).
 * Only the oracle's private key (in the Vault DON) can decrypt.
 */
export function encryptContext(plaintext: string, publicKeyHex: string): EciesBundle {
  const ephemeralPrivate = utils.randomSecretKey();
  const ephemeralPublic = getPublicKey(ephemeralPrivate, true); // compressed, 33 bytes

  const sharedSecret = getSharedSecret(ephemeralPrivate, hexToBytes(publicKeyHex));
  const aesKey = sha256(sharedSecret);

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = gcm(aesKey, nonce);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));

  // Pack: ephemeralPublic (33) + nonce (12) + ciphertext (variable, tag included)
  const packed = new Uint8Array(33 + 12 + ciphertext.length);
  packed.set(ephemeralPublic, 0);
  packed.set(nonce, 33);
  packed.set(ciphertext, 45);

  return ("0x" + bytesToHex(packed)) as EciesBundle;
}

/**
 * Decrypt an ECIES-encrypted payload with a secp256k1 private key.
 * In production only the CRE oracle inside the TEE holds the privkey; this is
 * kept for round-trip tests and the CRE-side mirror.
 */
export function decryptContext(encryptedHex: string, privateKeyHex: string): string {
  const packed = hexToBytes(encryptedHex);

  const ephemeralPublic = packed.slice(0, 33);
  const nonce = packed.slice(33, 45);
  const ciphertext = packed.slice(45);

  const sharedSecret = getSharedSecret(hexToBytes(privateKeyHex), ephemeralPublic);
  const aesKey = sha256(sharedSecret);

  const decipher = gcm(aesKey, nonce);
  const decrypted = decipher.decrypt(ciphertext);

  return new TextDecoder().decode(decrypted);
}

/**
 * Derive the compressed (33-byte) public key from a private key.
 */
export function getPublicKeyFromPrivate(privateKeyHex: string): string {
  const pub = getPublicKey(hexToBytes(privateKeyHex), true);
  return bytesToHex(pub);
}
