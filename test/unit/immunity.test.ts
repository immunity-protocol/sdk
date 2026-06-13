import { describe, expect, it } from "vitest";
import { Immunity } from "../../src/immunity.js";
import type { Address } from "../../src/types/antibody.js";
import type { Signer } from "ethers";
import { NotStartedError } from "../../src/types/errors.js";

// A throwaway private key — start() is never called, so it is never used to
// connect; the constructor only needs a truthy wallet.
const WALLET = `0x${"1".repeat(64)}` as unknown as Signer;
const TARGET = "0x00000000000000000000000000000000000000a1" as Address;

describe("Immunity.check guards", () => {
  it("rejects with NotStartedError before start()", async () => {
    const im = new Immunity({ wallet: WALLET, network: "base-sepolia" });
    await expect(im.check({ to: TARGET, chainId: 84532 }, {})).rejects.toBeInstanceOf(NotStartedError);
  });
});
