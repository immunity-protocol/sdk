import type { Hex32 } from "../types/antibody.js";

/**
 * CID ⇄ Hex32 mapping for `Antibody.evidenceCid`.
 *
 * On-chain we store ONLY the 32-byte sha2-256 digest (a `bytes32`). The full
 * fetch CID is reconstructed deterministically from that digest by pinning the
 * CID version + codec + hash function as SDK constants below. The storage
 * gateway MUST return CIDs that match this shape (CIDv1, `raw` codec,
 * sha2-256) — otherwise the digest alone could not be turned back into the
 * exact CID the content is addressed by. Incompatible CIDs are rejected with a
 * clear error rather than silently truncated.
 */

/** CIDv1. */
const CID_VERSION = 0x01;
/** Multicodec `raw` (0x55) — evidence envelopes are stored as raw bytes. */
const CODEC_RAW = 0x55;
/** Multihash function code for sha2-256. */
const MH_SHA2_256 = 0x12;
/** sha2-256 digest length in bytes. */
const DIGEST_LEN = 0x20;

/** RFC4648 base32 lowercase alphabet (multibase prefix `b`). */
const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const B32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B32_ALPHABET.length; i++) B32_LOOKUP[B32_ALPHABET.charAt(i)] = i;

/** Encode an unsigned integer as a LEB128 varint. */
function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/** Decode a LEB128 varint at `offset`; returns the value and the next offset. */
function decodeVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= bytes.length) throw new Error("malformed CID: truncated varint");
    const byte = bytes[pos++] as number;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

/** RFC4648 base32 (no padding) encode. */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

/** RFC4648 base32 (no padding) decode. */
function base32Decode(str: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of str) {
    const idx = B32_LOOKUP[ch];
    if (idx === undefined) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function hexToBytes32(hex: Hex32): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`expected a 32-byte 0x hex digest, got: ${hex}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reconstruct the canonical CIDv1 (raw, sha2-256) string from a 32-byte
 * digest. Multibase-prefixed with `b` (base32 lower); always starts `bafkrei…`.
 */
export function hex32ToCid(hex32: Hex32): string {
  const digest = hexToBytes32(hex32);
  const header = [
    ...encodeVarint(CID_VERSION),
    ...encodeVarint(CODEC_RAW),
    ...encodeVarint(MH_SHA2_256),
    ...encodeVarint(DIGEST_LEN),
  ];
  const cidBytes = Uint8Array.from([...header, ...digest]);
  return `b${base32Encode(cidBytes)}`;
}

/**
 * Extract the 32-byte sha2-256 digest from a CIDv1/raw/sha2-256 string and
 * return it as a `Hex32` for on-chain storage. Rejects CIDv0, non-`raw`
 * codecs, and non-sha2-256 / non-32-byte multihashes with a clear error.
 */
export function cidToHex32(cid: string): Hex32 {
  if (cid.length === 0) throw new Error("empty CID");
  if (cid[0] !== "b") {
    throw new Error(
      `unsupported CID encoding '${cid[0]}': expected multibase base32 (CIDv1, prefix 'b'). ` +
        "The storage gateway must return CIDv1/raw/sha2-256 CIDs.",
    );
  }
  const bytes = base32Decode(cid.slice(1));
  let off = 0;
  let version: number;
  let codec: number;
  let hashFn: number;
  let length: number;
  [version, off] = decodeVarint(bytes, off);
  if (version !== CID_VERSION) throw new Error(`unsupported CID version ${version}: expected CIDv1`);
  [codec, off] = decodeVarint(bytes, off);
  if (codec !== CODEC_RAW) {
    throw new Error(`unsupported CID codec 0x${codec.toString(16)}: expected raw (0x55)`);
  }
  [hashFn, off] = decodeVarint(bytes, off);
  if (hashFn !== MH_SHA2_256) {
    throw new Error(`unsupported multihash 0x${hashFn.toString(16)}: expected sha2-256 (0x12)`);
  }
  [length, off] = decodeVarint(bytes, off);
  if (length !== DIGEST_LEN) {
    throw new Error(`unsupported digest length ${length}: expected 32 bytes`);
  }
  const digest = bytes.slice(off);
  if (digest.length !== DIGEST_LEN) {
    throw new Error(`malformed CID: digest is ${digest.length} bytes, expected ${DIGEST_LEN}`);
  }
  return `0x${bytesToHex(digest)}` as Hex32;
}
