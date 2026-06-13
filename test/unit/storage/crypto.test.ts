import { describe, expect, it } from "vitest";
import { decryptContext, encryptContext, getPublicKeyFromPrivate } from "../../../src/storage/crypto.js";

/** Fixed test recipient keypair (test-only — never a real oracle key). */
const PRIV = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PUB = getPublicKeyFromPrivate(PRIV);

describe("ECIES context crypto", () => {
  it("round-trips encryptContext -> decryptContext", () => {
    const msg = JSON.stringify({ kind: "evidence-context", secret: "to the CRE only" });
    const blob = encryptContext(msg, PUB);
    expect(blob.startsWith("0x")).toBe(true);
    expect(decryptContext(blob, PRIV)).toBe(msg);
  });

  it("produces a fresh ephemeral key + nonce each call (non-deterministic ciphertext)", () => {
    const msg = "same plaintext";
    expect(encryptContext(msg, PUB)).not.toBe(encryptContext(msg, PUB));
  });

  it("packs the ENShell wire layout: ephemeralPub(33) || nonce(12) || ciphertext+tag", () => {
    const blob = encryptContext("layout check", PUB);
    const bytes = Buffer.from(blob.slice(2), "hex");
    // 33-byte compressed ephemeral pubkey (0x02/0x03 prefix), 12-byte nonce, then ciphertext+16B tag.
    expect(bytes.length).toBeGreaterThan(33 + 12 + 16);
    expect([0x02, 0x03]).toContain(bytes[0]);
  });

  it("decrypts a frozen blob produced by an independent ENShell-format encrypt (cross-impl)", () => {
    // Generated out-of-band with ENShell's verbatim encryptForOracle logic against PRIV's pubkey.
    // Proves the CRE workflow (identical decrypt) will read exactly what this SDK writes.
    const FIXTURE_PLAINTEXT = JSON.stringify({
      kind: "evidence-context",
      note: "immunity ecies cross-impl fixture",
    });
    const FIXTURE_ENCRYPTED =
      "0x02539df04be1d33481b827f3ca60e3d5d8cb390fdf5e9ed5229d81052e4ce6dc8754f06ccaab80c6bb075a4b6bff4acc99de25c76e7d3a84cf67db420669238c5d1b0092a4afc8edb220d9ef90a9bc321cb4f4e219dc7997de25409680d8c77f85a112ef4f3211e90c1ee3f376688f0c963a75417355bc2926120fa8ac575f63fa8672";
    expect(decryptContext(FIXTURE_ENCRYPTED, PRIV)).toBe(FIXTURE_PLAINTEXT);
  });

  it("getPublicKeyFromPrivate returns a 33-byte compressed key (bare hex, no 0x)", () => {
    expect(PUB.length).toBe(33 * 2);
    expect(["02", "03"]).toContain(PUB.slice(0, 2));
  });
});
