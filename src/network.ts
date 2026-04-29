import type { NetworkConfig, NetworkPreset } from "./types/config.js";
import { MissingConfigError } from "./types/errors.js";

/**
 * 0G Galileo testnet preset. Source of truth: the `.deploy.json` produced by
 * the immunity-contracts-0g Hardhat ignition module.
 *
 * Re-snapshot if a redeploy moves the Registry or MockUSDC addresses.
 */
export const TESTNET: NetworkConfig = {
  name: "galileo-testnet",
  chainId: 16602,
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  registryAddress: "0xbbD14Ff50480085cA3071314ca0AA73768569679",
  usdcAddress: "0x39D484EaBd1e6be837f9dbbb1DE540d425A70061",
  blockExplorerUrl: "https://chainscan-galileo.0g.ai",
  storageIndexerUrl: "https://indexer-storage-testnet-turbo.0g.ai",
  computeProvider: "0xa48f01287233509FD694a22Bf840225062E67836",
  computeModel: "qwen-2.5-7b-instruct",
  axlHubs: [],
  ensRpcUrl: "https://eth.llamarpc.com",
};

export function resolveNetwork(input: NetworkPreset | NetworkConfig | undefined): NetworkConfig {
  if (input === undefined || input === "testnet") return TESTNET;
  if (input === "custom") {
    throw new MissingConfigError(
      "network",
      "preset 'custom' requires a NetworkConfig object, not a string",
    );
  }
  return input;
}
