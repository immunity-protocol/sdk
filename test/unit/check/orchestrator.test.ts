import { describe, expect, it, vi } from "vitest";
import {
  type CheckDeps,
  type ResolvedCheckConfig,
  runCheck,
} from "../../../src/check/orchestrator.js";
import { ZERO_BYTES32 } from "../../../src/check/settle.js";
import type { NovelVerifier } from "../../../src/check/verifier.js";
import type { EnforcementResolution } from "../../../src/registry/enforcement.js";
import type { RawVerdict } from "../../../src/tee/parse.js";
import type { Address, Antibody } from "../../../src/types/antibody.js";
import type { EnforcementInputs } from "../../../src/types/enforcement.js";
import { buildAntibody } from "../matchers/fixtures.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;
const HASH = `0x${"ab".repeat(32)}`;

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

function antibody(): Antibody {
  return buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
}

function res(
  tier: EnforcementResolution["tier"],
  antibodies: Antibody[] = [],
  ins: EnforcementInputs[] = [],
): EnforcementResolution {
  return { tier, source: tier === "none" ? "none" : "cache", antibodies, inputs: ins };
}

function verdict(over: Partial<RawVerdict> = {}): RawVerdict {
  return {
    verdict: "MALICIOUS",
    abType: "ADDRESS",
    flavor: null,
    confidence: 95,
    severity: 80,
    reasoning: "test",
    marker: null,
    ...over,
  };
}

function cfg(over: Partial<ResolvedCheckConfig> = {}): ResolvedCheckConfig {
  return {
    unverifiedAntibodyPolicy: "escalate",
    novelThreatPolicy: "verify",
    thresholds: { block: 85, escalate: 60 },
    onTimeout: "deny",
    ...over,
  };
}

function makeDeps(over: {
  resolution?: EnforcementResolution;
  config?: Partial<ResolvedCheckConfig>;
  verifier?: NovelVerifier;
  registryThrows?: boolean;
} = {}): { deps: CheckDeps; check: ReturnType<typeof vi.fn> } {
  const check = over.registryThrows
    ? vi.fn(async () => {
        throw new Error("insufficient balance");
      })
    : vi.fn(async () => ({ hash: HASH }));
  const deps: CheckDeps = {
    resolver: { resolve: vi.fn(async () => over.resolution ?? res("none")) },
    registry: { check },
    corroborationK: async () => 3,
    config: cfg(over.config),
    verifier: over.verifier,
    now: () => 1_700_000_000_000,
  };
  return { deps, check };
}

// A native value transfer so extractFacts yields populated txFacts (chainId,
// amount). The resolver is mocked, so the tx content does not affect the tier.
const PROBE_TX = { to: TARGET, value: 1000n, chainId: CHAIN };

describe("runCheck — hard-block", () => {
  it("blocks, settles with the matched id, calls registry.check once", async () => {
    const ab = antibody();
    const { deps, check } = makeDeps({
      resolution: res("hard-block", [ab], [inputs({ isSeeded: true })]),
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(result.allowed).toBe(false);
    expect(result.source).toBe("cache");
    expect(result.checkId).toBe(HASH);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(ab.keccakId, expect.any(String), expect.any(BigInt), CHAIN);
  });
});

describe("runCheck — advisory policies", () => {
  it("ignore → allow but STILL settles the fee", async () => {
    const ab = antibody();
    const { deps, check } = makeDeps({
      resolution: res("advisory", [ab], [inputs()]),
      config: { unverifiedAntibodyPolicy: "ignore" },
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("allow");
    expect(result.allowed).toBe(true);
    expect(check).toHaveBeenCalledTimes(1); // fee is mandatory
    expect(check).toHaveBeenCalledWith(ab.keccakId, expect.any(String), expect.any(BigInt), CHAIN);
  });

  it("block → block", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: { unverifiedAntibodyPolicy: "block" },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("escalate: operator allow → allow", async () => {
    const onEscalate = vi.fn(async () => true);
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: { onEscalate },
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("allow");
    expect(onEscalate).toHaveBeenCalledOnce();
  });

  it("escalate: operator block → block", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: { onEscalate: async () => false },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("escalate: handler throws + onTimeout deny → block", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: {
        onTimeout: "deny",
        onEscalate: async () => {
          throw new Error("handler boom");
        },
      },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("escalate: handler throws + onTimeout allow → allow", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: {
        onTimeout: "allow",
        onEscalate: async () => {
          throw new Error("handler boom");
        },
      },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("allow");
  });

  it("escalate: handler times out → onTimeout (deny → block)", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: {
        onTimeout: "deny",
        escalationTimeout: 5,
        onEscalate: () => new Promise((resolve) => setTimeout(() => resolve(true), 1000)),
      },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("escalate: no handler + onTimeout deny → block", async () => {
    const { deps } = makeDeps({
      resolution: res("advisory", [antibody()], [inputs()]),
      config: { onTimeout: "deny" },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });
});

describe("runCheck — novel verify", () => {
  it("verifier malicious+confident → block with source tee", async () => {
    const verifier: NovelVerifier = { verify: vi.fn(async () => verdict({ confidence: 95 })) };
    const { deps } = makeDeps({ resolution: res("none"), verifier });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(result.source).toBe("tee");
  });

  it("verifier benign → allow", async () => {
    const verifier: NovelVerifier = { verify: vi.fn(async () => verdict({ verdict: "BENIGN" })) };
    const { deps } = makeDeps({ resolution: res("none"), verifier });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("allow");
  });

  it("settles bytes32(0) for a novel/no-match check", async () => {
    const verifier: NovelVerifier = { verify: vi.fn(async () => verdict({ verdict: "BENIGN" })) };
    const { deps, check } = makeDeps({ resolution: res("none"), verifier });
    await runCheck(deps, PROBE_TX, {});
    expect(check).toHaveBeenCalledWith(ZERO_BYTES32, expect.any(String), expect.any(BigInt), CHAIN);
  });

  it("per-call options.policy overrides the configured novel policy", async () => {
    const { deps } = makeDeps({
      resolution: res("none"),
      config: { novelThreatPolicy: "verify" },
    });
    // No verifier; force trust-cache via options → allow without verifying.
    const result = await runCheck(deps, PROBE_TX, {}, { policy: "trust-cache" });
    expect(result.decision).toBe("allow");
    expect(result.novel).toBe(true);
  });
});

describe("runCheck — novel verify FAILS CLOSED", () => {
  it("verifier absent + onTimeout deny → block, source policy", async () => {
    const { deps } = makeDeps({ resolution: res("none"), config: { onTimeout: "deny" } });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(result.source).toBe("policy");
    expect(result.reason).toMatch(/tier-3/);
  });

  it("verifier throws + onTimeout deny → block", async () => {
    const verifier: NovelVerifier = {
      verify: vi.fn(async () => {
        throw new Error("cre down");
      }),
    };
    const { deps } = makeDeps({ resolution: res("none"), verifier, config: { onTimeout: "deny" } });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("verifier times out → block", async () => {
    const verifier: NovelVerifier = {
      verify: () => new Promise((resolve) => setTimeout(() => resolve(verdict()), 1000)),
    };
    const { deps } = makeDeps({
      resolution: res("none"),
      verifier,
      config: { onTimeout: "deny", escalationTimeout: 5 },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("verifier absent + onTimeout allow + onEscalate allow → allow (the ONLY allow path)", async () => {
    const { deps } = makeDeps({
      resolution: res("none"),
      config: { onTimeout: "allow", onEscalate: async () => true },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("allow");
  });

  it("verifier absent + onTimeout allow + NO onEscalate → block (never allow on fallback)", async () => {
    const { deps } = makeDeps({ resolution: res("none"), config: { onTimeout: "allow" } });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("verifier absent + onTimeout allow + onEscalate block → block", async () => {
    const { deps } = makeDeps({
      resolution: res("none"),
      config: { onTimeout: "allow", onEscalate: async () => false },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });

  it("verifier absent + onTimeout allow + onEscalate throws → block (no allow without explicit allow)", async () => {
    const { deps } = makeDeps({
      resolution: res("none"),
      config: {
        onTimeout: "allow",
        onEscalate: async () => {
          throw new Error("operator unreachable");
        },
      },
    });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });
});

describe("runCheck — novel non-verify policies", () => {
  it("trust-cache → allow, novel=true, source policy", async () => {
    const { deps } = makeDeps({ resolution: res("none"), config: { novelThreatPolicy: "trust-cache" } });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result).toMatchObject({ decision: "allow", novel: true, source: "policy" });
  });

  it("deny-novel → block", async () => {
    const { deps } = makeDeps({ resolution: res("none"), config: { novelThreatPolicy: "deny-novel" } });
    expect((await runCheck(deps, PROBE_TX, {})).decision).toBe("block");
  });
});

describe("runCheck — settlement is decision-independent", () => {
  it("a settlement revert does NOT flip a block to allow", async () => {
    const ab = antibody();
    const { deps } = makeDeps({
      resolution: res("hard-block", [ab], [inputs({ isSeeded: true })]),
      registryThrows: true,
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(result.allowed).toBe(false);
    expect(result.checkId).toBeNull();
    expect(result.reason).toMatch(/settlement not recorded/);
  });

  it("populates txFacts from the proposed tx", async () => {
    const { deps } = makeDeps({ resolution: res("none"), config: { novelThreatPolicy: "trust-cache" } });
    const result = await runCheck(deps, { to: TARGET, value: 1000n, chainId: CHAIN }, {});
    expect(result.txFacts.originChainId).toBe(CHAIN);
    expect(result.txFacts.tokenAmount).toBe(1000n);
  });
});
