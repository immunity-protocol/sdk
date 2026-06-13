import { describe, expect, it, vi } from "vitest";
import {
  type SettlementRegistry,
  ZERO_BYTES32,
  selectSettleAntibodyId,
  settle,
} from "../../../src/check/settle.js";
import type { EnforcementResolution } from "../../../src/registry/enforcement.js";
import type { TxFacts } from "../../../src/tx/extractFacts.js";
import type { Address, Antibody, Hex32 } from "../../../src/types/antibody.js";
import type { EnforcementInputs } from "../../../src/types/enforcement.js";
import { buildAntibody } from "../matchers/fixtures.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;
const K = 3;
const NOW = 2_000_000_000n;

function inputs(over: Partial<EnforcementInputs> = {}): EnforcementInputs {
  return {
    status: "ACTIVE",
    corroboration: 0,
    publisherRep: 0n,
    prominenceTier: 0,
    maturedAt: 0n,
    expiresAt: 0n,
    isSeeded: false,
    ...over,
  };
}

function ab(immSeq: number): Antibody {
  return { ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }), immSeq };
}

function resolution(
  tier: EnforcementResolution["tier"],
  antibodies: Antibody[],
  ins: EnforcementInputs[],
): EnforcementResolution {
  return { tier, source: tier === "none" ? "none" : "registry", antibodies, inputs: ins };
}

const FACTS: TxFacts = {
  tokenAddress: "0x000000000000000000000000000000000000c0de" as Address,
  tokenAmount: 1_000_000n,
  originChainId: CHAIN,
};

describe("selectSettleAntibodyId", () => {
  it("returns the matched antibody id for a single hard-block", () => {
    const a = ab(7);
    const id = selectSettleAntibodyId(resolution("hard-block", [a], [inputs({ isSeeded: true })]), K, NOW);
    expect(id).toBe(a.keccakId);
  });

  it("prefers the hard-block antibody over an advisory in a mixed set", () => {
    const advisory = ab(1);
    const blocker = ab(2);
    const id = selectSettleAntibodyId(
      resolution("hard-block", [advisory, blocker], [inputs({ corroboration: 0 }), inputs({ corroboration: 3 })]),
      K,
      NOW,
    );
    expect(id).toBe(blocker.keccakId);
  });

  it("tiebreaks equal tiers by lowest immSeq", () => {
    const later = ab(9);
    const earlier = ab(4);
    const id = selectSettleAntibodyId(
      resolution("hard-block", [later, earlier], [inputs({ isSeeded: true }), inputs({ isSeeded: true })]),
      K,
      NOW,
    );
    expect(id).toBe(earlier.keccakId);
  });

  it("returns bytes32(0) for a novel (tier none) check", () => {
    expect(selectSettleAntibodyId(resolution("none", [], []), K, NOW)).toBe(ZERO_BYTES32);
  });

  it("returns bytes32(0) for an empty antibody set", () => {
    expect(selectSettleAntibodyId(resolution("advisory", [], []), K, NOW)).toBe(ZERO_BYTES32);
  });
});

describe("settle", () => {
  it("returns the tx hash as checkId on success", async () => {
    const HASH = `0x${"ab".repeat(32)}`;
    const registry: SettlementRegistry = { check: vi.fn(async () => ({ hash: HASH })) };
    const id = `0x${"1".repeat(64)}` as Hex32;

    const res = await settle(registry, id, FACTS);
    expect(res.checkId).toBe(HASH);
    expect(res.note).toBeUndefined();
    expect(registry.check).toHaveBeenCalledWith(id, FACTS.tokenAddress, FACTS.tokenAmount, FACTS.originChainId);
  });

  it("surfaces a revert as checkId=null + note, without throwing", async () => {
    const registry: SettlementRegistry = {
      check: vi.fn(async () => {
        throw new Error("insufficient balance");
      }),
    };
    const res = await settle(registry, ZERO_BYTES32, FACTS);
    expect(res.checkId).toBeNull();
    expect(res.note).toContain("insufficient balance");
  });
});
