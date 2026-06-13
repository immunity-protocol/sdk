import { describe, expect, it } from "vitest";
import type { Hex32 } from "../../../src/types/antibody.js";
import { cidToHex32, hex32ToCid } from "../../../src/storage/cid.js";

// sha2-256 digest of a known evidence-envelope fixture.
const DIGEST: Hex32 = "0xa5aceef07eedc92df674a78966df6bcb607e5a29144be0a077361e80b8056971";

describe("CID ⇄ Hex32 mapping", () => {
  it("round-trips hex32 -> cid -> hex32", () => {
    const cid = hex32ToCid(DIGEST);
    expect(cidToHex32(cid)).toBe(DIGEST);
  });

  it("round-trips cid -> hex32 -> cid", () => {
    const cid = hex32ToCid(DIGEST);
    expect(hex32ToCid(cidToHex32(cid))).toBe(cid);
  });

  it("emits a CIDv1/raw/sha2-256 CID (bafkrei… prefix)", () => {
    // The version+codec+hashfn+length header bytes [0x01,0x55,0x12,0x20] base32
    // to a fixed prefix regardless of digest.
    expect(hex32ToCid(DIGEST).startsWith("bafkrei")).toBe(true);
  });

  it("rejects a CIDv0 (Qm…) CID", () => {
    expect(() => cidToHex32("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toThrow(
      /unsupported CID encoding/,
    );
  });

  it("rejects a non-raw (dag-pb) CIDv1", () => {
    expect(() =>
      cidToHex32("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"),
    ).toThrow(/unsupported CID codec/);
  });

  it("rejects a non-32-byte hex digest", () => {
    expect(() => hex32ToCid("0xdeadbeef" as Hex32)).toThrow(/32-byte/);
  });
});
