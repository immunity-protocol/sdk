import { describe, expect, it } from "vitest";
import { cidToHex32, hex32ToCid } from "../../../src/storage/cid.js";
import type { Hex32 } from "../../../src/types/antibody.js";

// A REAL CIDv0/dag-pb/sha2-256 fixture from the gateway Step-0 verdict
// (gateway-cid-verdict.md): a 40-byte JSON pinned via Lighthouse.
const REAL_CID = "QmXE7xhPkmfF4tdXmwSh6ZUWydKn6fmaE9FVasfzWUxou2";
// sha2-256 multihash digest of a known evidence-envelope fixture.
const DIGEST: Hex32 = "0xa5aceef07eedc92df674a78966df6bcb607e5a29144be0a077361e80b8056971";

describe("CID ⇄ Hex32 mapping (CIDv0/dag-pb)", () => {
  it("decodes a real Qm… fixture to a 32-byte digest and back", () => {
    const digest = cidToHex32(REAL_CID);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hex32ToCid(digest)).toBe(REAL_CID);
  });

  it("round-trips hex32 -> cid -> hex32", () => {
    const cid = hex32ToCid(DIGEST);
    expect(cidToHex32(cid)).toBe(DIGEST);
  });

  it("round-trips cid -> hex32 -> cid", () => {
    const cid = hex32ToCid(DIGEST);
    expect(hex32ToCid(cidToHex32(cid))).toBe(cid);
  });

  it("emits a CIDv0 CID (Qm… prefix, 46 chars)", () => {
    const cid = hex32ToCid(DIGEST);
    expect(cid.startsWith("Qm")).toBe(true);
    expect(cid).toHaveLength(46);
  });

  it("rejects a CIDv1 (bafkrei…/raw) CID", () => {
    expect(() =>
      cidToHex32("bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52gy"),
    ).toThrow(/unsupported CID/);
  });

  it("rejects a CIDv1 (bafybei…/dag-pb) CID", () => {
    expect(() =>
      cidToHex32("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"),
    ).toThrow(/unsupported CID/);
  });

  it("rejects a malformed base58 CID (invalid character)", () => {
    // '0' (zero) is not in the base58btc alphabet.
    expect(() => cidToHex32("Qm0invalidbase58chars000000000000000000000000")).toThrow(
      /invalid base58btc character/,
    );
  });

  it("rejects a non-32-byte hex digest", () => {
    expect(() => hex32ToCid("0xdeadbeef" as Hex32)).toThrow(/32-byte/);
  });
});
