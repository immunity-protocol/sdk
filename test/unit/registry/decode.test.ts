import { describe, expect, it } from "vitest";
import {
  type RawAntibody,
  type RawEnforcementInputs,
  decodeAntibody,
  decodeEnforcementInputs,
} from "../../../src/registry/decode.js";
import {
  AntibodyTypeValue,
  type Hex32,
  StatusValue,
  VerdictValue,
} from "../../../src/types/antibody.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex32;
const PUB = "0x00000000000000000000000000000000000000Ab";
const REV = "0x00000000000000000000000000000000000000Cd";

// A realistic ethers-style raw struct: integers as bigint, hashes/addresses as
// 0x strings. `isSeeded` is a uint8 here (1/0), unlike getEnforcementInputs.
function rawAntibody(over: Partial<RawAntibody> = {}): RawAntibody {
  return {
    primaryMatcherHash: `0x${"1".repeat(64)}`,
    evidenceCid: `0x${"2".repeat(64)}`,
    contextHash: `0x${"3".repeat(64)}`,
    embeddingHash: `0x${"4".repeat(64)}`,
    attestation: `0x${"5".repeat(64)}`,
    publisher: PUB,
    immSeq: 42n,
    createdAt: 1_700_000_000n, // 2023-11-14 UTC
    reviewer: REV,
    expiresAt: 0n,
    abType: 1n, // CALL_PATTERN
    flavor: 0n,
    verdict: 1n, // SUSPICIOUS
    confidence: 90n,
    bondAmount: 1_000_000n,
    escrowedFees: 500_000n,
    maturedAt: 1_700_000_500n,
    severity: 80n,
    status: 2n, // CHALLENGED
    isSeeded: 1n,
    prominenceTier: 1n,
    ...over,
  };
}

describe("decodeAntibody", () => {
  it("round-trips a known struct (enums, bigints, addresses, immId, seed)", () => {
    const id = `0x${"a".repeat(64)}` as Hex32;
    const ab = decodeAntibody(id, rawAntibody());

    expect(ab.keccakId).toBe(id);
    expect(ab.immSeq).toBe(42);
    expect(ab.immId).toBe("IMM-2023-0042"); // year from createdAt
    expect(ab.abType).toBe("CALL_PATTERN");
    expect(ab.verdict).toBe("SUSPICIOUS");
    expect(ab.status).toBe("CHALLENGED");
    expect(ab.confidence).toBe(90);
    expect(ab.severity).toBe(80);
    expect(ab.prominenceTier).toBe(1);
    expect(ab.bondAmount).toBe(1_000_000n);
    expect(ab.escrowedFees).toBe(500_000n);
    expect(ab.maturedAt).toBe(1_700_000_500n);
    expect(ab.createdAt).toBe(1_700_000_000n);
    expect(ab.expiresAt).toBe(0n);
    // addresses lowercased
    expect(ab.publisher).toBe(PUB.toLowerCase());
    expect(ab.reviewer).toBe(REV.toLowerCase());
    // isSeeded uint8 -> boolean
    expect(ab.isSeeded).toBe(true);
    // chain stores no seed
    expect(ab.seed).toBeUndefined();
  });

  it("maps isSeeded uint8 0 -> false", () => {
    expect(decodeAntibody(ZERO32, rawAntibody({ isSeeded: 0n })).isSeeded).toBe(false);
  });

  it("maps every status enum value", () => {
    for (const [name, code] of Object.entries(StatusValue)) {
      expect(decodeAntibody(ZERO32, rawAntibody({ status: BigInt(code) })).status).toBe(name);
    }
  });

  it("maps every abType enum value", () => {
    for (const [name, code] of Object.entries(AntibodyTypeValue)) {
      expect(decodeAntibody(ZERO32, rawAntibody({ abType: BigInt(code) })).abType).toBe(name);
    }
  });

  it("maps every verdict enum value", () => {
    for (const [name, code] of Object.entries(VerdictValue)) {
      expect(decodeAntibody(ZERO32, rawAntibody({ verdict: BigInt(code) })).verdict).toBe(name);
    }
  });

  it("throws on an unknown enum code", () => {
    expect(() => decodeAntibody(ZERO32, rawAntibody({ status: 99n }))).toThrow(/status/);
  });

  it("accepts number inputs as well as bigint (hand-built mocks)", () => {
    const ab = decodeAntibody(ZERO32, rawAntibody({ immSeq: 7, status: 1, isSeeded: 0 }));
    expect(ab.immSeq).toBe(7);
    expect(ab.status).toBe("ACTIVE");
    expect(ab.isSeeded).toBe(false);
  });
});

function rawInputs(over: Partial<RawEnforcementInputs> = {}): RawEnforcementInputs {
  return {
    status: 1n, // ACTIVE
    corroboration: 3n,
    publisherRep: 12_345n,
    prominenceTier: 1n,
    maturedAt: 1_700_000_000n,
    expiresAt: 1_800_000_000n,
    isSeeded: true,
    ...over,
  };
}

describe("decodeEnforcementInputs", () => {
  it("maps the 7-tuple to typed inputs (bool isSeeded)", () => {
    const i = decodeEnforcementInputs(rawInputs());
    expect(i.status).toBe("ACTIVE");
    expect(i.corroboration).toBe(3);
    expect(i.publisherRep).toBe(12_345n);
    expect(i.prominenceTier).toBe(1);
    expect(i.maturedAt).toBe(1_700_000_000n);
    expect(i.expiresAt).toBe(1_800_000_000n);
    expect(i.isSeeded).toBe(true);
  });

  it("reverse-maps each status enum value", () => {
    for (const [name, code] of Object.entries(StatusValue)) {
      expect(decodeEnforcementInputs(rawInputs({ status: BigInt(code) })).status).toBe(name);
    }
  });

  it("treats isSeeded as a real boolean", () => {
    expect(decodeEnforcementInputs(rawInputs({ isSeeded: false })).isSeeded).toBe(false);
  });
});
