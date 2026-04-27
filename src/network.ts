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
  registryAddress: "0x6FfB52ea1a01ABDe2793f6fca2Ea6661ca75903c",
  usdcAddress: "0x53d4Df2832A97Ec455D1d0ACe9242baE78f19eC9",
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
