import { describe, expect, it } from "vitest";
import {
  type RawCorpusEntry,
  SEED_CHAIN_ID,
  buildCorpus,
  buildTarget,
} from "../../../scripts/seed/corpus.js";
import { hashAddressMatcher } from "../../../src/index.js";

function entry(target: string, over: Partial<RawCorpusEntry> = {}): RawCorpusEntry {
  return {
    seed: { abType: "ADDRESS", chainId: 16602, target },
    verdict: "MALICIOUS",
    confidence: 96,
    severity: 95,
    reasoning: "OFAC SDN listing",
    seed_source: "ofac_sdn",
    evidence_url: "https://ofac.treasury.gov/x",
    ...over,
  };
}

const A = "0x8589427373d6D84E98730D7795D8f6f8731FDa16";

describe("seed corpus", () => {
  it("overrides the corpus chainId to Base Sepolia", () => {
    const t = buildTarget(entry(A), 0, false);
    expect(t.chainId).toBe(SEED_CHAIN_ID);
    expect((t.input.seed as { chainId: number }).chainId).toBe(SEED_CHAIN_ID);
  });

  it("lowercases the target and derives the shared matcher hash", () => {
    const t = buildTarget(entry(A), 0, false);
    expect(t.target).toBe(A.toLowerCase());
    expect(t.matcherHash).toBe(hashAddressMatcher({ chainId: SEED_CHAIN_ID, target: t.target }));
  });

  it("attaches encrypted context only for CRE-demo targets", () => {
    expect(buildTarget(entry(A), 0, false).input.context).toBeUndefined();
    const demo = buildTarget(entry(A), 0, true);
    expect(demo.isCreDemo).toBe(true);
    const ctx = JSON.parse(demo.input.context ?? "{}");
    expect(ctx.reasoning).toBe("OFAC SDN listing");
    expect(ctx.seedSource).toBe("ofac_sdn");
  });

  it("maps the verdict, defaulting unknown to MALICIOUS", () => {
    expect(buildTarget(entry(A, { verdict: "SUSPICIOUS" }), 0, false).input.verdict).toBe(
      "SUSPICIOUS",
    );
    expect(buildTarget(entry(A, { verdict: "whatever" }), 0, false).input.verdict).toBe(
      "MALICIOUS",
    );
  });

  it("rejects non-ADDRESS targets", () => {
    expect(() =>
      buildTarget(entry(A, { seed: { abType: "BYTECODE", chainId: 1, target: A } }), 0, false),
    ).toThrow(/only ADDRESS/);
  });

  it("selects the first N and flags the first M as CRE-demo", () => {
    const raw = [
      entry(`0x${"1".repeat(40)}`),
      entry(`0x${"2".repeat(40)}`),
      entry(`0x${"3".repeat(40)}`),
    ];
    const corpus = buildCorpus(raw, { count: 2, creDemoCount: 1 });
    expect(corpus).toHaveLength(2);
    expect(corpus[0]?.isCreDemo).toBe(true);
    expect(corpus[1]?.isCreDemo).toBe(false);
  });
});
