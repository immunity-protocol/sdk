import { describe, expect, it, vi } from "vitest";
import { AddressMatcher } from "../../../src/matchers/address.js";
import { BytecodeMatcher } from "../../../src/matchers/bytecode.js";
import { CallPatternMatcher } from "../../../src/matchers/call-pattern.js";
import { GraphMatcher } from "../../../src/matchers/graph.js";
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

  it("locks the full first-hit-wins priority order", () => {
    const r = new MatcherRegistry();
    // Register out of order; the registry must sort cheap-first.
    r.register(new SemanticMatcher());
    r.register(new BytecodeMatcher(CHAIN, async () => "0x"));
    r.register(new AddressMatcher(CHAIN));
    r.register(new GraphMatcher(CHAIN));
    r.register(new CallPatternMatcher(CHAIN));
    expect(r.list().map((m) => m.name)).toEqual([
      "ADDRESS",
      "CALL_PATTERN",
      "GRAPH",
      "BYTECODE",
      "SEMANTIC",
    ]);
    expect(r.list().map((m) => m.priority)).toEqual([10, 20, 30, 40, 50]);
  });

  it("short-circuits expensive matchers once a cheap one hits", async () => {
    const addrAb = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([addrAb]);

    let fetcherCalls = 0;
    const bytecode = new BytecodeMatcher(CHAIN, async () => {
      fetcherCalls++;
      return "0x6080";
    });
    const semantic = new SemanticMatcher();
    const address = new AddressMatcher(CHAIN);
    for (const m of [address, bytecode, semantic]) m.attach(cache);

    const bytecodeSpy = vi.spyOn(bytecode, "match");
    const semanticSpy = vi.spyOn(semantic, "match");

    const r = new MatcherRegistry();
    r.register(semantic);
    r.register(bytecode);
    r.register(address);

    const hit = await r.matchFirst({
      tx: { to: TARGET, chainId: CHAIN },
      context: { conversation: [{ role: "user", content: "anything" }] },
    });
    expect(hit?.matcherName).toBe("ADDRESS");
    // The ADDRESS hit (priority 10) short-circuits BYTECODE's RPC and SEMANTIC's scan.
    expect(bytecodeSpy).not.toHaveBeenCalled();
    expect(semanticSpy).not.toHaveBeenCalled();
    expect(fetcherCalls).toBe(0);
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

  it("matchAll collects every hit across matchers (no short-circuit)", async () => {
    const addrAb = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const semanticAb = buildAntibody({
      abType: "SEMANTIC",
      flavor: "MANIPULATION",
      pattern: { kind: "marker", value: "rugpull" },
    });
    const cache = makeCache([addrAb, semanticAb]);
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    a.attach(cache);
    s.attach(cache);
    const r = new MatcherRegistry();
    r.register(s);
    r.register(a);

    const hits = await r.matchAll({
      tx: { to: TARGET, chainId: CHAIN },
      context: { conversation: [{ role: "user", content: "rugpull alert" }] },
    });
    // Both the ADDRESS and SEMANTIC matchers hit — matchFirst would have stopped
    // at ADDRESS; matchAll surfaces both, in priority order.
    expect(hits.map((h) => h.matcherName)).toEqual(["ADDRESS", "SEMANTIC"]);
  });

  it("matchAll returns an empty array when no matchers hit", async () => {
    const cache = makeCache([]);
    const a = new AddressMatcher(CHAIN);
    const s = new SemanticMatcher();
    a.attach(cache);
    s.attach(cache);
    const r = new MatcherRegistry();
    r.register(a);
    r.register(s);

    expect(
      await r.matchAll({
        tx: { to: "0x0000000000000000000000000000000000000099", chainId: CHAIN },
        context: {},
      }),
    ).toEqual([]);
  });
});
