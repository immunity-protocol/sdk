import { describe, expect, it, vi } from "vitest";
import {
  type WriteDeps,
  balanceOf,
  challenge,
  deposit,
  deregister,
  isRegistered,
  mature,
  registerPublisher,
  withdraw,
} from "../../../src/publish/operations.js";
import type { Address } from "../../../src/types/antibody.js";
import { AlreadyRegisteredError } from "../../../src/types/errors.js";
import { TEST_NETWORK } from "../../fixtures/network.js";

const PUBLISHER = "0x0000000000000000000000000000000000000aaa" as Address;
const HASH = `0x${"ab".repeat(32)}`;
const ANTIBODY_ID = `0x${"cd".repeat(32)}`;

function tx() {
  return { hash: HASH, wait: vi.fn(async () => ({})) };
}

function makeDeps(
  over: {
    allowance?: bigint;
    registered?: boolean;
    registrationBond?: bigint;
    bondAmount?: bigint;
    challengeBondBps?: number;
    minChallengeBond?: bigint;
    balance?: bigint;
  } = {},
): WriteDeps {
  // Stateful allowance: a successful approve raises it, mirroring the chain so
  // `ensureAllowance`'s post-approve confirmation poll terminates.
  let allowance = over.allowance ?? 0n;
  return {
    publisher: PUBLISHER,
    network: TEST_NETWORK,
    usdc: {
      allowance: vi.fn(async () => allowance),
      approve: vi.fn(async (_spender: string, amount: bigint) => {
        allowance = amount;
        return tx();
      }),
    },
    registrar: {
      registrationBond: vi.fn(async () => over.registrationBond ?? 10_000_000n),
      isRegistered: vi.fn(async () => over.registered ?? false),
      registerPublisher: vi.fn(async () => tx()),
      deregister: vi.fn(async () => tx()),
    },
    registry: {
      deposit: vi.fn(async () => tx()),
      withdraw: vi.fn(async () => tx()),
      balances: vi.fn(async () => over.balance ?? 0n),
      publish: vi.fn(async () => tx()),
      mature: vi.fn(async () => tx()),
      getAntibody: vi.fn(async () => ({ immSeq: 7n, bondAmount: over.bondAmount ?? 0n })),
    },
    challengeManager: {
      challengeBondBps: vi.fn(async () => over.challengeBondBps ?? 10_000),
      minChallengeBond: vi.fn(async () => over.minChallengeBond ?? 5_000_000n),
      challenge: vi.fn(async () => tx()),
    },
    storage: { putEvidence: vi.fn() },
  };
}

describe("registerPublisher", () => {
  it("approves the registrar for the bond then registers", async () => {
    const deps = makeDeps({ allowance: 0n, registrationBond: 10_000_000n });
    const out = await registerPublisher(deps, "alice");
    expect(deps.usdc.approve).toHaveBeenCalledWith(TEST_NETWORK.addresses.registrar, 10_000_000n);
    expect(deps.registrar.registerPublisher).toHaveBeenCalledWith("alice");
    expect(out).toEqual({ txHash: HASH, bond: 10_000_000n });
  });

  it("skips approve when allowance already covers the bond", async () => {
    const deps = makeDeps({ allowance: 50_000_000n, registrationBond: 10_000_000n });
    await registerPublisher(deps, "alice");
    expect(deps.usdc.approve).not.toHaveBeenCalled();
  });

  it("throws AlreadyRegisteredError when already registered", async () => {
    const deps = makeDeps({ registered: true });
    await expect(registerPublisher(deps, "alice")).rejects.toBeInstanceOf(AlreadyRegisteredError);
    expect(deps.registrar.registerPublisher).not.toHaveBeenCalled();
  });
});

describe("deregister / isRegistered", () => {
  it("deregister calls through", async () => {
    const deps = makeDeps();
    expect(await deregister(deps)).toEqual({ txHash: HASH });
    expect(deps.registrar.deregister).toHaveBeenCalledOnce();
  });

  it("isRegistered reads the publisher's status", async () => {
    const deps = makeDeps({ registered: true });
    expect(await isRegistered(deps)).toBe(true);
    expect(deps.registrar.isRegistered).toHaveBeenCalledWith(PUBLISHER);
  });
});

describe("deposit / withdraw / balanceOf", () => {
  it("deposit approves the registry then deposits", async () => {
    const deps = makeDeps({ allowance: 0n });
    await deposit(deps, 25_000_000n);
    expect(deps.usdc.approve).toHaveBeenCalledWith(TEST_NETWORK.addresses.registry, 25_000_000n);
    expect(deps.registry.deposit).toHaveBeenCalledWith(25_000_000n);
  });

  it("deposit rejects a non-positive amount", async () => {
    await expect(deposit(makeDeps(), 0n)).rejects.toThrow(/greater than 0/);
  });

  it("withdraw calls through", async () => {
    const deps = makeDeps();
    await withdraw(deps, 1_000_000n);
    expect(deps.registry.withdraw).toHaveBeenCalledWith(1_000_000n);
  });

  it("balanceOf reads the operator balance", async () => {
    const deps = makeDeps({ balance: 42_000_000n });
    expect(await balanceOf(deps)).toBe(42_000_000n);
    expect(deps.registry.balances).toHaveBeenCalledWith(PUBLISHER);
  });
});

describe("challenge", () => {
  it("uses the floor when the scaled bond is below minChallengeBond", async () => {
    const deps = makeDeps({
      bondAmount: 2_000_000n,
      challengeBondBps: 10_000,
      minChallengeBond: 5_000_000n,
    });
    const out = await challenge(deps, ANTIBODY_ID);
    // scaled = 2_000_000 × 10000/10000 = 2_000_000 < 5_000_000 floor
    expect(out.bond).toBe(5_000_000n);
    expect(deps.usdc.approve).toHaveBeenCalledWith(
      TEST_NETWORK.addresses.challengeManager,
      5_000_000n,
    );
    expect(deps.challengeManager.challenge).toHaveBeenCalledWith(ANTIBODY_ID);
  });

  it("scales off the antibody bond when above the floor", async () => {
    const deps = makeDeps({
      bondAmount: 8_000_000n,
      challengeBondBps: 10_000,
      minChallengeBond: 5_000_000n,
    });
    const out = await challenge(deps, ANTIBODY_ID);
    expect(out.bond).toBe(8_000_000n);
  });
});

describe("mature", () => {
  it("calls registry.mature", async () => {
    const deps = makeDeps();
    await mature(deps, ANTIBODY_ID);
    expect(deps.registry.mature).toHaveBeenCalledWith(ANTIBODY_ID);
  });
});
