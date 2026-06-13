import { BASE_SEPOLIA } from "../../src/network.js";
import type { NetworkConfig } from "../../src/types/config.js";

/**
 * Shared test fixture for "the network this SDK build targets". Tests that
 * need a representative chain id, addresses, etc. import from here rather than
 * hardcoding so a future network change is a single-file edit.
 */
export const TEST_CHAIN_ID = BASE_SEPOLIA.chainId;

export const TEST_NETWORK: NetworkConfig = BASE_SEPOLIA;
