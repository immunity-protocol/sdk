import { JsonRpcProvider } from "ethers";
import { describe, expect, it } from "vitest";
import { registryContract, reputationContract } from "../../src/contracts.js";
import { BASE_SEPOLIA } from "../../src/network.js";

/**
 * S1 foundation smoke: prove the SDK's OWN config + bindings can read the LIVE
 * Base Sepolia core network. View-only (no signer/key needed). If the public
 * RPC is flaky this can be retried; it is the foundation's source of truth that
 * the SDK talks to the real deployed contracts.
 */
describe("live Base Sepolia foundation smoke", () => {
  const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId);
  const registry = registryContract(BASE_SEPOLIA.addresses.registry, provider);
  const reputation = reputationContract(BASE_SEPOLIA.addresses.reputation, provider);

  // A disclosed genesis publisher granted 100 at deploy.
  const GENESIS_0 = "0x18628A448938aD61C3AAd97Eca1f99DE310684B4";

  it("reads protectedMultiplier == 1000 from the live Registry", async () => {
    expect(await registry.protectedMultiplier()).toBe(1000n);
  });

  it("reads corroborationK == 3 from the live Registry", async () => {
    expect(await registry.corroborationK()).toBe(3n);
  });

  it("reads a genesis publisher's reputation == 100 from the live Reputation", async () => {
    expect(await reputation.scoreOf(GENESIS_0)).toBe(100n);
  });
});
