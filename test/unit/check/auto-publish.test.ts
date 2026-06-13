import { describe, expect, it, vi } from "vitest";
import {
  type CheckDeps,
  type ConfirmedThreatPublisher,
  type ResolvedCheckConfig,
  runCheck,
} from "../../../src/check/orchestrator.js";
import type { NovelVerifier } from "../../../src/check/verifier.js";
import type { EnforcementResolution } from "../../../src/registry/enforcement.js";
import type { RawVerdict } from "../../../src/tee/parse.js";
import type { Address, Antibody } from "../../../src/types/antibody.js";
import type { EnforcementInputs } from "../../../src/types/enforcement.js";
import type { PublishResult } from "../../../src/publish/params.js";
import { buildAntibody } from "../matchers/fixtures.js";

const CHAIN = 84532;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;
const HASH = `0x${"ab".repeat(32)}`;

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

function res(
  tier: EnforcementResolution["tier"],
  antibodies: Antibody[] = [],
  ins: EnforcementInputs[] = [],
): EnforcementResolution {
  return { tier, source: tier === "none" ? "none" : "cache", antibodies, inputs: ins };
}

const PUBLISH_RESULT = { keccakId: `0x${"11".repeat(32)}`, immSeq: 7 } as unknown as PublishResult;

function cfg(over: Partial<ResolvedCheckConfig> = {}): ResolvedCheckConfig {
  return {
    unverifiedAntibodyPolicy: "escalate",
    novelThreatPolicy: "verify",
    thresholds: { block: 85, escalate: 60 },
    onTimeout: "deny",
    autoPublishConfirmedThreats: false,
    ...over,
  };
}

function makeDeps(over: {
  resolution?: EnforcementResolution;
  config?: Partial<ResolvedCheckConfig>;
  verifierVerdict?: RawVerdict;
  publishConfirmedThreat?: ConfirmedThreatPublisher;
} = {}): { deps: CheckDeps; hook: ReturnType<typeof vi.fn> } {
  const verifier: NovelVerifier = {
    verify: vi.fn(async () => over.verifierVerdict ?? verdict()),
  };
  const hook = vi.fn(over.publishConfirmedThreat ?? (async () => PUBLISH_RESULT));
  const deps: CheckDeps = {
    resolver: { resolve: vi.fn(async () => over.resolution ?? res("none")) },
    registry: { check: vi.fn(async () => ({ hash: HASH })) },
    corroborationK: async () => 3,
    config: cfg(over.config),
    verifier,
    publishConfirmedThreat: hook,
    now: () => 1_700_000_000_000,
  };
  return { deps, hook };
}

const PROBE_TX = { to: TARGET, value: 1000n, chainId: CHAIN };

describe("auto-publish seam — gating", () => {
  it("flag OFF → never invokes the write hook, no pendingWrite", async () => {
    const { deps, hook } = makeDeps({ config: { autoPublishConfirmedThreats: false } });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block"); // confident-malicious verdict
    expect(hook).not.toHaveBeenCalled();
    expect(result.pendingWrite).toBeUndefined();
  });

  it("flag ON + confirmed novel → invokes the hook (mode verify), sets pendingWrite", async () => {
    const { deps, hook } = makeDeps({ config: { autoPublishConfirmedThreats: true } });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0]).toMatchObject({ mode: "verify" });
    expect(result.pendingWrite).toBeDefined();
    expect(await result.pendingWrite).toBe(PUBLISH_RESULT);
  });

  it("flag ON but verdict NOT confirmed (benign) → no hook, no pendingWrite", async () => {
    const { deps, hook } = makeDeps({
      config: { autoPublishConfirmedThreats: true },
      verifierVerdict: verdict({ verdict: "BENIGN" }),
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("allow");
    expect(hook).not.toHaveBeenCalled();
    expect(result.pendingWrite).toBeUndefined();
  });

  it("flag ON + advisory corroborate → invokes the hook with mode corroborate", async () => {
    const ab = buildAntibody({ abType: "ADDRESS", chainId: CHAIN, target: TARGET });
    const { deps, hook } = makeDeps({
      resolution: res("advisory", [ab], [inputs()]),
      config: { autoPublishConfirmedThreats: true, unverifiedAntibodyPolicy: "corroborate" },
    });
    await runCheck(deps, PROBE_TX, {});
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0]).toMatchObject({ mode: "corroborate" });
  });
});

describe("auto-publish seam — detached + safe", () => {
  it("does NOT await the publish in the decision path", async () => {
    // A hook that never resolves: if runCheck awaited it, this would time out.
    const { deps } = makeDeps({
      config: { autoPublishConfirmedThreats: true },
      publishConfirmedThreat: () => new Promise<PublishResult | null>(() => {}),
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(result.pendingWrite).toBeDefined();
  });

  it("a rejecting publish is caught → pendingWrite resolves null, no unhandled rejection", async () => {
    const { deps } = makeDeps({
      config: { autoPublishConfirmedThreats: true },
      publishConfirmedThreat: async () => {
        throw new Error("publish boom");
      },
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(result.decision).toBe("block");
    expect(await result.pendingWrite).toBeNull();
  });

  it("a skipped publish (hook returns null) surfaces pendingWrite resolving null", async () => {
    const { deps } = makeDeps({
      config: { autoPublishConfirmedThreats: true },
      publishConfirmedThreat: async () => null,
    });
    const result = await runCheck(deps, PROBE_TX, {});
    expect(await result.pendingWrite).toBeNull();
  });
});
