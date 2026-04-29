import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { afterAll, describe, expect, it } from "vitest";
import RegistryArtifact from "../../abi/Registry.json" with { type: "json" };
import { Immunity, parseUsdc, TESTNET } from "../../src/index.js";
import { Tier2LookupClient } from "../../src/registry/lookup.js";
import { hashAddressMatcher } from "../../src/keccak/matchers/address.js";
import { createRegistryClient } from "../../src/settlement/registry-client.js";
import type { Address } from "../../src/types/antibody.js";

/**
 * Tier-2 end-to-end against deployed Galileo Registry v3 (matcherIndex).
 *
 * Two SDK paths exercised here:
 *
 *   1. Direct lookup: publish a fresh ADDRESS antibody, then resolve it via
 *      `getAntibodyByMatcherHash` against the live chain. Validates the SDK
 *      matcher hash format and the contract's matcherIndex agree byte-for-byte.
 *
 *   2. Three-tier check(): a second SDK instance with a cold cache should
 *      resolve via Tier-2 (`source: "registry"`) without reaching for TEE.
 *      This is the headline correctness gain over v2.
 *
 * Skipped when WALLET_PRIVATE_KEY / AXL_URL are missing so unit-test runs
 * do not fail.
 */
const WALLET = process.env.WALLET_PRIVATE_KEY;
const AXL_URL = process.env.AXL_URL;
const SHOULD_RUN = Boolean(WALLET) && Boolean(AXL_URL);

describe.skipIf(!SHOULD_RUN)("Tier-2 lookup end-to-end", () => {
  const provider = new JsonRpcProvider(TESTNET.rpcUrl);
  const signer = new Wallet(WALLET!, provider);

  const immunity = new Immunity({
    wallet: signer,
    network: "testnet",
    axlUrl: AXL_URL!,
    // trust-cache so an ADDRESS not yet in the cache does NOT escalate to
    // the TEE; we want Tier-2 to be the resolver here.
    novelThreatPolicy: "trust-cache",
  });

  afterAll(async () => {
    await immunity.stop();
  });

  it("publishes and resolves the same matcher hash via getAntibodyByMatcherHash", async () => {
    await immunity.start();

    const balance = await immunity.balance();
    if (balance < parseUsdc("3")) {
      await immunity.mintTestUsdc(parseUsdc("5"));
      await immunity.deposit(parseUsdc("3"));
    }

    const target = randomAddress();
    const pub = await immunity.publish({
      seed: { abType: "ADDRESS", chainId: TESTNET.chainId, target },
      verdict: "MALICIOUS",
      confidence: 95,
      severity: 90,
      reasonSummary: "tier2 e2e",
    });

    const matcherHash = hashAddressMatcher({ chainId: TESTNET.chainId, target });

    // Direct contract call mirrors what the SDK's lookup client does.
    const registryContract = new Contract(
      TESTNET.registryAddress,
      RegistryArtifact.abi,
      provider,
    );
    const result = (await registryContract.getAntibodyByMatcherHash(matcherHash)) as {
      antibody: { publisher: string; primaryMatcherHash: string };
      exists: boolean;
    };
    expect(result.exists).toBe(true);
    expect(result.antibody.publisher.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(result.antibody.primaryMatcherHash.toLowerCase()).toBe(matcherHash.toLowerCase());

    // Confirm the matcherIndex maps to the same keccakId publish() returned.
    const indexed = (await registryContract.matcherIndex(matcherHash)) as string;
    expect(indexed.toLowerCase()).toBe(pub.keccakId.toLowerCase());
  }, 120_000);

  it("Tier2LookupClient surfaces an antibody known to the chain but not the cache", async () => {
    const target = randomAddress();
    await immunity.publish({
      seed: { abType: "ADDRESS", chainId: TESTNET.chainId, target },
      verdict: "MALICIOUS",
      confidence: 95,
      severity: 90,
      reasonSummary: "tier2 lookup test",
    });

    // Build a fresh client with no cache state.
    const registry = createRegistryClient(TESTNET.registryAddress, signer);
    const client = new Tier2LookupClient(registry, TESTNET.chainId);
    const matcherHash = hashAddressMatcher({ chainId: TESTNET.chainId, target });

    const result = await client.getAntibodyByMatcherHash(matcherHash);
    expect(result.exists).toBe(true);
    expect(result.antibody?.primaryMatcherHash.toLowerCase()).toBe(matcherHash.toLowerCase());
  }, 120_000);
});

function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.toLowerCase() as Address;
}
