import { describe, expect, it, vi } from "vitest";
import { AntibodyCache } from "../../../src/cache/cache.js";
import { hashAddressMatcher } from "../../../src/keccak/matchers/address.js";
import { hashBytecodeMatcher } from "../../../src/keccak/matchers/bytecode.js";
import { hashCallPatternMatcher } from "../../../src/keccak/matchers/call-pattern.js";
import { AddressMatcher } from "../../../src/matchers/address.js";
import { BytecodeMatcher, type CodeFetcher } from "../../../src/matchers/bytecode.js";
import { MatcherRegistry } from "../../../src/matchers/matcher.js";
import type { RawAntibody, RawEnforcementInputs } from "../../../src/registry/decode.js";
import { EnforcementResolver } from "../../../src/registry/enforcement.js";
import { type RegistryReads, Tier2Lookup } from "../../../src/registry/lookup.js";
import { NegativeMatcherCache } from "../../../src/registry/negative-cache.js";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Address, Hex32 } from "../../../src/types/antibody.js";
import { buildAntibody, bytecodeHashFor, makeCache } from "../matchers/fixtures.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;
const EOA: CodeFetcher = async () => "0x";

function id(seed: string): Hex32 {
  return keccak256(toUtf8Bytes(seed)) as Hex32;
}

function rawInputs(over: Partial<RawEnforcementInputs> = {}): RawEnforcementInputs {
  return {
    status: 1n,
    corroboration: 0n,
    publisherRep: 0n,
    prominenceTier: 0n,
    maturedAt: 0n,
    expiresAt: 0n,
    isSeeded: false,
    ...over,
  };
}

function rawAntibody(over: Partial<RawAntibody> = {}): RawAntibody {
  return {
    primaryMatcherHash: `0x${"1".repeat(64)}`,
    evidenceCid: `0x${"0".repeat(64)}`,
    contextHash: `0x${"0".repeat(64)}`,
    embeddingHash: `0x${"0".repeat(64)}`,
    attestation: `0x${"0".repeat(64)}`,
    publisher: "0x00000000000000000000000000000000000000aa",
    immSeq: 1n,
    createdAt: 1_700_000_000n,
    reviewer: "0x0000000000000000000000000000000000000000",
    expiresAt: 0n,
    abType: 0n,
    flavor: 0n,
    verdict: 0n,
    confidence: 90n,
    bondAmount: 0n,
    escrowedFees: 0n,
    maturedAt: 0n,
    severity: 80n,
    status: 1n,
    isSeeded: 0n,
    prominenceTier: 0n,
    ...over,
  };
}

/** Build a mock RegistryReads driven by per-matcher-hash and per-id maps. */
function mockReads(cfg: {
  byMatcher?: Record<Hex32, Hex32[]>;
  inputs?: Record<Hex32, RawEnforcementInputs>;
  antibodies?: Record<Hex32, RawAntibody>;
  k?: number;
}): RegistryReads & { spies: { byMatcher: ReturnType<typeof vi.fn> } } {
  const byMatcher = vi.fn(async (h: Hex32) => cfg.byMatcher?.[h.toLowerCase() as Hex32] ?? []);
  return {
    spies: { byMatcher },
    corroborationK: vi.fn(async () => cfg.k ?? 3),
    getAntibodiesByMatcher: byMatcher,
    getEnforcementInputs: vi.fn(async (id: Hex32) => cfg.inputs?.[id] ?? rawInputs()),
    getAntibody: vi.fn(async (id: Hex32) => cfg.antibodies?.[id] ?? rawAntibody()),
  };
}

function makeResolver(reads: RegistryReads, cache: AntibodyCache, opts: { codeFetcher?: CodeFetcher; negativeCache?: NegativeMatcherCache } = {}) {
  const address = new AddressMatcher(CHAIN);
  address.attach(cache);
  const matchers = new MatcherRegistry();
  matchers.register(address);
  const negativeCache = opts.negativeCache ?? new NegativeMatcherCache();
  return {
    resolver: new EnforcementResolver({
      reads,
      matchers,
      cache,
      negativeCache,
      codeFetcher: opts.codeFetcher ?? EOA,
      chainId: CHAIN,
    }),
    negativeCache,
  };
}

describe("matcher rework: live antibodies surface, tier decided read-side", () => {
  it("PROBATION antibody produces a Tier-1 hit and resolves advisory", async () => {
    const ab = { ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }), status: "PROBATION" as const };
    const cache = makeCache([ab]);
    const reads = mockReads({ inputs: { [ab.keccakId]: rawInputs({ status: 0n, corroboration: 0n }) } });
    const { resolver } = makeResolver(reads, cache);

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.source).toBe("cache");
    expect(res.tier).toBe("advisory");
    expect(res.antibodies.map((a) => a.keccakId)).toEqual([ab.keccakId]);
  });

  it("a corroborated PROBATION antibody resolves hard-block", async () => {
    const ab = { ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }), status: "PROBATION" as const };
    const cache = makeCache([ab]);
    const reads = mockReads({ inputs: { [ab.keccakId]: rawInputs({ status: 0n, corroboration: 3n }) } });
    const { resolver } = makeResolver(reads, cache);
    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.tier).toBe("hard-block");
  });

  it("SLASHED and TTL-expired antibodies do NOT match at Tier-1", async () => {
    const slashed = { ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }), status: "SLASHED" as const };
    const address = new AddressMatcher(CHAIN);
    address.attach(makeCache([slashed]));
    expect(await address.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} })).toBeNull();

    const expired = {
      ...buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET }),
      status: "ACTIVE" as const,
      expiresAt: 1n, // long past
    };
    const a2 = new AddressMatcher(CHAIN);
    a2.attach(makeCache([expired]));
    expect(await a2.match({ tx: { to: TARGET, chainId: CHAIN }, context: {} })).toBeNull();
  });
});

describe("Tier-1 strongest-tier aggregation (matchAll)", () => {
  it("a cheap advisory ADDRESS hit no longer hides a hard-block BYTECODE hit", async () => {
    const CODE = "0x6080604052348015" as const;
    const addrAb = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const codeAb = buildAntibody({ abType: "BYTECODE", bytecodeHash: bytecodeHashFor(CODE) });
    const cache = makeCache([addrAb, codeAb]);

    const address = new AddressMatcher(CHAIN);
    const bytecode = new BytecodeMatcher(CHAIN, async () => CODE);
    address.attach(cache);
    bytecode.attach(cache);
    const matchers = new MatcherRegistry();
    matchers.register(address);
    matchers.register(bytecode);

    const reads = mockReads({
      inputs: {
        [addrAb.keccakId]: rawInputs({ corroboration: 0n }), // advisory (cheap, priority 10)
        [codeAb.keccakId]: rawInputs({ isSeeded: true }), // hard-block (priority 40)
      },
    });
    const resolver = new EnforcementResolver({
      reads,
      matchers,
      cache,
      negativeCache: new NegativeMatcherCache(),
      codeFetcher: async () => CODE,
      chainId: CHAIN,
    });

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.source).toBe("cache");
    expect(res.tier).toBe("hard-block");
    expect(res.antibodies).toHaveLength(2);
  });

  it("dedups a single antibody hit by two matchers", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const a1 = new AddressMatcher(CHAIN);
    const a2 = new AddressMatcher(CHAIN);
    a1.attach(cache);
    a2.attach(cache);
    const matchers = new MatcherRegistry();
    matchers.register(a1);
    matchers.register(a2);

    const reads = mockReads({ inputs: { [ab.keccakId]: rawInputs({ corroboration: 0n }) } });
    const resolver = new EnforcementResolver({
      reads,
      matchers,
      cache,
      negativeCache: new NegativeMatcherCache(),
      codeFetcher: EOA,
      chainId: CHAIN,
    });

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.antibodies).toHaveLength(1);
    expect(res.tier).toBe("advisory");
  });
});

describe("denyKeccakIds muting", () => {
  it("a muted sole Tier-1 matcher produces no enforcement", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const cache = makeCache([ab]);
    const address = new AddressMatcher(CHAIN);
    address.attach(cache);
    const matchers = new MatcherRegistry();
    matchers.register(address);

    const resolver = new EnforcementResolver({
      reads: mockReads({ inputs: { [ab.keccakId]: rawInputs({ isSeeded: true }) } }),
      matchers,
      cache,
      negativeCache: new NegativeMatcherCache(),
      codeFetcher: EOA,
      chainId: CHAIN,
      denyKeccakIds: [ab.keccakId],
    });

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    // Muted out of Tier-1, nothing on chain for it → novel path.
    expect(res.tier).toBe("none");
    expect(res.source).toBe("none");
  });

  it("a muted id among K corroborators still hard-blocks via the others", async () => {
    const addrHash = hashAddressMatcher({ chainId: CHAIN, target: TARGET });
    const MUTED = id("muted");
    const OTHER = id("other");
    const reads = mockReads({
      byMatcher: { [addrHash]: [MUTED, OTHER] },
      inputs: {
        [MUTED]: rawInputs({ isSeeded: true }),
        [OTHER]: rawInputs({ corroboration: 3n }), // hard-block on its own
      },
    });
    const cache = new AntibodyCache();
    const address = new AddressMatcher(CHAIN);
    address.attach(cache);
    const matchers = new MatcherRegistry();
    matchers.register(address);

    const resolver = new EnforcementResolver({
      reads,
      matchers,
      cache,
      negativeCache: new NegativeMatcherCache(),
      codeFetcher: EOA,
      chainId: CHAIN,
      denyKeccakIds: [MUTED],
    });

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.tier).toBe("hard-block");
    expect(res.antibodies.map((a) => a.keccakId)).toEqual([OTHER]);
  });
});

describe("Tier2Lookup", () => {
  const lookup = (reads: RegistryReads, negativeCache: NegativeMatcherCache, cache = new AntibodyCache()) =>
    new Tier2Lookup({ reads, cache, negativeCache, codeFetcher: EOA, defaultChainId: CHAIN });

  it("derives ADDRESS + CALL_PATTERN + BYTECODE candidate hashes (not SEMANTIC/GRAPH)", async () => {
    const CODE = "0x6080604052";
    const codeFetcher: CodeFetcher = async () => CODE;
    const l = new Tier2Lookup({
      reads: mockReads({}),
      cache: new AntibodyCache(),
      negativeCache: new NegativeMatcherCache(),
      codeFetcher,
      defaultChainId: CHAIN,
    });
    const selector = "0xa9059cbb";
    const args = "0".repeat(128);
    const probe = { tx: { to: TARGET, chainId: CHAIN, data: `${selector}${args}` as `0x${string}` }, context: {} };
    const hashes = new Set(await l.candidateMatcherHashes(probe));

    expect(hashes.has(hashAddressMatcher({ chainId: CHAIN, target: TARGET }))).toBe(true);
    expect(
      hashes.has(hashCallPatternMatcher({ chainId: CHAIN, target: TARGET, selector, argsTemplate: `0x${args}` })),
    ).toBe(true);
    expect(hashes.has(hashCallPatternMatcher({ chainId: CHAIN, target: TARGET, selector, argsTemplate: "0x" }))).toBe(true);
    expect(hashes.has(hashBytecodeMatcher({ bytecodeHash: keccak256(CODE) as Hex32 }))).toBe(true);
  });

  it("marks absent on empty result and evicts on non-empty", async () => {
    const hash = hashAddressMatcher({ chainId: CHAIN, target: TARGET });
    const nc = new NegativeMatcherCache();

    const empty = lookup(mockReads({}), nc);
    expect(await empty.lookupMatcher(hash)).toEqual([]);
    expect(nc.isCachedAsAbsent(hash)).toBe(true);

    const ID = id("ab1");
    const nonEmpty = lookup(mockReads({ byMatcher: { [hash]: [ID] } }), nc);
    expect(await nonEmpty.lookupMatcher(hash)).toEqual([ID]);
    expect(nc.isCachedAsAbsent(hash)).toBe(false); // evicted
  });

  it("hydrate decodes and puts the antibody in the cache", async () => {
    const ID = id("ab2");
    const cache = new AntibodyCache();
    const l = lookup(mockReads({ antibodies: { [ID]: rawAntibody({ abType: 2n }) } }), new NegativeMatcherCache(), cache);
    const ab = await l.hydrate(ID);
    expect(ab.keccakId).toBe(ID);
    expect(ab.abType).toBe("BYTECODE");
    expect(ab.seed).toBeUndefined();
    expect(cache.has(ID)).toBe(true);
  });
});

describe("EnforcementResolver Tier-2", () => {
  it("resolves via the registry, hydrates into cache, returns source=registry", async () => {
    const addrHash = hashAddressMatcher({ chainId: CHAIN, target: TARGET });
    const ID = id("hit");
    const reads = mockReads({
      byMatcher: { [addrHash]: [ID] },
      inputs: { [ID]: rawInputs({ corroboration: 3n }) }, // hard-block
      antibodies: { [ID]: rawAntibody() },
    });
    const cache = new AntibodyCache();
    const { resolver } = makeResolver(reads, cache);

    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.source).toBe("registry");
    expect(res.tier).toBe("hard-block");
    expect(res.antibodies).toHaveLength(1);
    expect(res.inputs).toHaveLength(1);
    expect(cache.has(ID)).toBe(true); // hydrated
  });

  it("returns the STRONGEST tier across a corroboration set", async () => {
    const addrHash = hashAddressMatcher({ chainId: CHAIN, target: TARGET });
    const ID1 = id("advisory");
    const ID2 = id("blocker");
    const reads = mockReads({
      byMatcher: { [addrHash]: [ID1, ID2] },
      inputs: {
        [ID1]: rawInputs({ corroboration: 0n }), // advisory
        [ID2]: rawInputs({ isSeeded: true }), // hard-block
      },
    });
    const { resolver } = makeResolver(reads, new AntibodyCache());
    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res.tier).toBe("hard-block");
    expect(res.antibodies).toHaveLength(2);
  });

  it("returns source=none when nothing matches", async () => {
    const { resolver } = makeResolver(mockReads({}), new AntibodyCache());
    const res = await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    expect(res).toEqual({ tier: "none", antibodies: [], inputs: [], source: "none" });
  });

  it("uses the negative cache to skip a repeat RPC for a known-absent matcher", async () => {
    const reads = mockReads({});
    const { resolver } = makeResolver(reads, new AntibodyCache());
    const probe = { tx: { to: TARGET, chainId: CHAIN }, context: {} };
    await resolver.resolve(probe);
    await resolver.resolve(probe);
    // Only ONE candidate hash (address; EOA code => no bytecode, no calldata =>
    // no call-pattern). Second resolve is short-circuited by the negative cache.
    expect(reads.spies.byMatcher).toHaveBeenCalledTimes(1);
  });

  it("propagates a lookup RPC error (never swallows into none)", async () => {
    const reads = mockReads({});
    reads.getAntibodiesByMatcher = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const { resolver } = makeResolver(reads, new AntibodyCache());
    await expect(resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} })).rejects.toThrow(
      /rpc down/,
    );
  });

  it("reads corroborationK only once across resolves", async () => {
    const reads = mockReads({});
    const { resolver } = makeResolver(reads, new AntibodyCache());
    await resolver.resolve({ tx: { to: TARGET, chainId: CHAIN }, context: {} });
    await resolver.resolve({ tx: { to: "0x00000000000000000000000000000000000000b2" as Address, chainId: CHAIN }, context: {} });
    expect(reads.corroborationK).toHaveBeenCalledTimes(1);
  });
});
