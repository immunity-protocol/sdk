import { Contract, JsonRpcProvider } from "ethers";
import { describe, expect, it } from "vitest";
import RegistryArtifact from "../../abi/Registry.json" with { type: "json" };
import { computeKeccakId } from "../../src/keccak/id.js";
import { TESTNET } from "../../src/network.js";

/**
 * Cross-validate the SDK's `computeKeccakId` against the deployed Registry's
 * `computeKeccakId(uint8,uint8,bytes32,address) external pure` view function.
 *
 * This runs against live Galileo testnet but only calls a pure function, so
 * it costs no gas and needs no signer.
 */
const RPC_URL = process.env.ZEROG_RPC_URL ?? TESTNET.rpcUrl;

describe("keccak parity vs deployed Registry", () => {
  it("matches for representative inputs", async () => {
    const provider = new JsonRpcProvider(RPC_URL);
    const registry = new Contract(TESTNET.registryAddress, RegistryArtifact.abi, provider);

    const fixtures: Array<{
      abType: 0 | 1 | 2 | 3 | 4;
      flavor: number;
      matcher: `0x${string}`;
      publisher: `0x${string}`;
    }> = [
      {
        abType: 0,
        flavor: 0,
        matcher: "0x0000000000000000000000000000000000000000000000000000000000000001",
        publisher: "0x0000000000000000000000000000000000000001",
      },
      {
        abType: 1,
        flavor: 0,
        matcher: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        publisher: "0xa48f01287233509fd694a22bf840225062e67836",
      },
      {
        abType: 4,
        flavor: 2,
        matcher: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        publisher: "0x45ee45ca358b3fc9b1b245a8f1c1c3128cac8e48",
      },
    ];

    const types = ["ADDRESS", "CALL_PATTERN", "BYTECODE", "GRAPH", "SEMANTIC"] as const;

    for (const f of fixtures) {
      const onChain = (await registry.computeKeccakId(
        f.abType,
        f.flavor,
        f.matcher,
        f.publisher,
      )) as string;
      const local = computeKeccakId(types[f.abType], f.flavor, f.matcher, f.publisher);
      expect(local.toLowerCase()).toBe(onChain.toLowerCase());
    }
  });
});
