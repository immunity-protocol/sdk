import { describe, expect, it } from "vitest";
import { AddressMatcher } from "../../../src/matchers/address.js";
import { buildAntibody, makeCache } from "./fixtures.js";

const TARGET = "0x000000000000000000000000000000000000DEAD" as const;
const CHAIN = 1;

describe("AddressMatcher", () => {
  it("matches on tx.to", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const m = new AddressMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: TARGET, chainId: CHAIN },
      context: {},
    });
    expect(hit?.antibody.keccakId).toBe(ab.keccakId);
  });

  it("matches case-insensitively", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const m = new AddressMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: TARGET.toUpperCase() as `0x${string}`, chainId: CHAIN },
      context: {},
    });
    expect(hit).not.toBeNull();
  });

  it("misses on unknown address", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const m = new AddressMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: "0x0000000000000000000000000000000000000001", chainId: CHAIN },
      context: {},
    });
    expect(hit).toBeNull();
  });

  it("matches on counterparty.id when it is an EVM address", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const m = new AddressMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: null,
      context: { counterparty: { id: TARGET } },
    });
    expect(hit).not.toBeNull();
  });

  it("ignores SLASHED antibodies", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    ab.status = "SLASHED";
    const cache = makeCache([ab]);
    const m = new AddressMatcher(CHAIN);
    m.attach(cache);

    const hit = await m.match({
      tx: { to: TARGET, chainId: CHAIN },
      context: {},
    });
    expect(hit).toBeNull();
  });
});
