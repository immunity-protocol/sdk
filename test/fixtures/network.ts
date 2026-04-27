import type { NetworkConfig } from "../../src/types/config.js";

/**
 * Shared test fixture for "the network this SDK build targets". Tests that
 * need a representative chain id, registry, etc. should import from here
 * rather than hardcoding `16602` so that a future network change is a
 * single-file edit.
 */
export const TEST_CHAIN_ID = 16602;

export const TEST_NETWORK: NetworkConfig = {
  name: "test-galileo",
  chainId: TEST_CHAIN_ID,
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  registryAddress: "0x45Ee45Ca358b3fc9B1b245a8f1c1C3128caC8e48",
  usdcAddress: "0x2Aee1d140422C62AE23465596801C35f3Ce74F9E",
  blockExplorerUrl: "https://chainscan-galileo.0g.ai",
  storageIndexerUrl: "https://indexer-storage-testnet-turbo.0g.ai",
  computeProvider: "0xa48f01287233509FD694a22Bf840225062E67836",
  computeModel: "qwen-2.5-7b-instruct",
  axlHubs: [],
  ensRpcUrl: "https://eth.llamarpc.com",
};
