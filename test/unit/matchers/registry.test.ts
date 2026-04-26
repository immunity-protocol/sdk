import { describe, expect, it } from "vitest";
import { AddressMatcher } from "../../../src/matchers/address.js";
import { MatcherRegistry } from "../../../src/matchers/matcher.js";
import { SemanticMatcher } from "../../../src/matchers/semantic.js";
import { buildAntibody, makeCache } from "./fixtures.js";

const TARGET = "0x000000000000000000000000000000000000DEAD" as const;
const CHAIN = 1;

describe("MatcherRegistry", () => {
  it("orders matchers by priority on register", () => {
    const r = new MatcherRegistry();
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    r.register(s);
    r.register(a);
    const order = r.list().map((m) => m.name);
    expect(order).toEqual(["ADDRESS", "SEMANTIC"]);
  });

  it("returns the first hit by priority", async () => {
    const addrAb = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const semanticAb = buildAntibody({
      abType: "SEMANTIC",
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "deadly" },
    });
    const cache = makeCache([addrAb, semanticAb]);
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    a.attach(cache);
    s.attach(cache);
    const r = new MatcherRegistry();
    r.register(s);
    r.register(a);

    const hit = await r.matchFirst({
      tx: { to: TARGET, chainId: CHAIN },
      context: { conversation: [{ role: "user", content: "deadly transfer" }] },
    });
    expect(hit?.matcherName).toBe("ADDRESS");
  });

  it("falls through to slower matchers when faster ones miss", async () => {
    const semanticAb = buildAntibody({
      abType: "SEMANTIC",
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "rugpull" },
    });
    const cache = makeCache([semanticAb]);
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    a.attach(cache);
    s.attach(cache);
    const r = new MatcherRegistry();
    r.register(s);
    r.register(a);

    const hit = await r.matchFirst({
      tx: { to: "0x0000000000000000000000000000000000000001", chainId: CHAIN },
      context: { conversation: [{ role: "user", content: "rugpull alert" }] },
    });
    expect(hit?.matcherName).toBe("SEMANTIC");
  });

  it("returns null when no matchers hit", async () => {
    const cache = makeCache([]);
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    a.attach(cache);
    s.attach(cache);
    const r = new MatcherRegistry();
    r.register(a);
    r.register(s);

    expect(
      await r.matchFirst({
        tx: { to: "0x0000000000000000000000000000000000000099", chainId: CHAIN },
        context: {},
      }),
    ).toBeNull();
  });
});
