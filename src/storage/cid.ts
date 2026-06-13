import type { Hex32 } from "../types/antibody.js";

/**
 * CID ⇄ Hex32 mapping for `Antibody.evidenceCid` / `contextHash`.
 *
 * On-chain we store ONLY the 32-byte sha2-256 multihash digest (a `bytes32`).
 * The full fetch CID is reconstructed deterministically from that digest by
 * pinning the CID shape as SDK constants below. The storage gateway returns
 * **CIDv0 / dag-pb (0x70) / sha2-256** (`Qm…`, base58btc) — Kubo's default — so
 * the bytes on-chain are the dag-pb/UnixFS multihash digest, NOT sha256 of the
 * raw file (UnixFS wraps the block before hashing).
 *
 * A CIDv0 is just the base58btc encoding of its multihash: `0x12 0x20 ‖ digest`
 * (no version/codec varints — the dag-pb codec is implicit in v0). Incompatible
 * CIDs (CIDv1 `b…`/`baf…`, wrong multihash, malformed) are rejected with a clear
 * error rather than silently truncated.
 */

/** Multihash function code for sha2-256. */
const MH_SHA2_256 = 0x12;
/** sha2-256 digest length in bytes. */
const DIGEST_LEN = 0x20;
/** Total CIDv0 multihash length: 0x12 ‖ 0x20 ‖ 32-byte digest. */
const CIDV0_LEN = 2 + DIGEST_LEN;

/** Bitcoin base58 alphabet (multibase `base58btc`). */
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_LOOKUP[B58_ALPHABET.charAt(i)] = i;

/** base58btc encode (big-endian; leading zero bytes → leading '1's). */
function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET.charAt(digits[i] as number);
  return out;
}

/** base58btc decode (big-endian; leading '1's → leading zero bytes). */
function base58btcDecode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str.charAt(zeros) === "1") zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const ch = str.charAt(i);
    const val = B58_LOOKUP[ch];
    if (val === undefined) throw new Error(`invalid base58btc character '${ch}'`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i] as number;
  return out;
}

function hexToBytes32(hex: Hex32): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`expected a 32-byte 0x hex digest, got: ${hex}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reconstruct the canonical CIDv0 (dag-pb, sha2-256) string from a 32-byte
 * digest: `base58btc(0x12 ‖ 0x20 ‖ digest)`. Always starts `Qm…` (46 chars).
 */
export function hex32ToCid(hex32: Hex32): string {
  const digest = hexToBytes32(hex32);
  const multihash = Uint8Array.from([MH_SHA2_256, DIGEST_LEN, ...digest]);
  return base58btcEncode(multihash);
}

/**
 * Extract the 32-byte sha2-256 digest from a CIDv0/dag-pb/sha2-256 string and
 * return it as a `Hex32` for on-chain storage. Rejects CIDv1 (`b…`/`baf…`),
 * non-sha2-256 multihashes, and malformed input with a clear error.
 */
export function cidToHex32(cid: string): Hex32 {
  if (cid.length === 0) throw new Error("empty CID");
  if (!cid.startsWith("Qm")) {
    throw new Error(
      `unsupported CID '${cid.slice(0, 8)}…': expected CIDv0 base58btc (prefix 'Qm'). ` +
        "The storage gateway returns CIDv0/dag-pb/sha2-256 CIDs; CIDv1 ('b…') is not accepted.",
    );
  }
  const bytes = base58btcDecode(cid);
  if (bytes.length !== CIDV0_LEN) {
    throw new Error(`malformed CIDv0: expected ${CIDV0_LEN} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== MH_SHA2_256 || bytes[1] !== DIGEST_LEN) {
    throw new Error(
      `unsupported multihash 0x${(bytes[0] as number).toString(16)} length ${bytes[1]}: ` +
        "expected sha2-256 (0x12) length 32 (0x20)",
    );
  }
  return `0x${bytesToHex(bytes.slice(2))}` as Hex32;
}
