import type { NetworkConfig, NetworkPreset } from "./types/config.js";
import { MissingConfigError } from "./types/errors.js";

/**
 * Base Sepolia preset — the LIVE Immunity core network.
 * Source of truth: `contracts-v1-plan/DEPLOYED-base-sepolia.md`
 * (deployed via immunity-contracts `ignition/modules/ImmunityCore.ts`).
 * Re-snapshot if a redeploy moves any address.
 */
export const BASE_SEPOLIA: NetworkConfig = {
  name: "base-sepolia",
  chainId: 84532,
  rpcUrl: "https://sepolia.base.org",
  blockExplorerUrl: "https://sepolia.basescan.org",
  lighthouseGateway: "https://gateway.lighthouse.storage/ipfs/",
  addresses: {
    registry: "0xdB155c21D26b917294BF0e2A1E46C9A14361BF44",
    reputation: "0x0e03F6Ca9e97447E2d97aFbFCe4cBF49202e9F25",
    registrar: "0x35F65a08a11f44F73622f51ade1911BC28036faF",
    protectedSet: "0xFc9EfB73662ccE25267e9E467c43e812F7C7A4d8",
    challengeManager: "0xe83525cA155e3f285Cc58f91cB1120338ecb2417",
    creReceiver: "0xA3FD7E9E7dDc32A25441b93F34AaEcEbE0304485",
    usdc: "0x26265722fa5d94bB3A3C866124aDdC7b85670b16",
    l2registry: "0xd37D0ad21179219796dD257E78357159bC8551e8",
  },
};

/**
 * Base mainnet preset — placeholder until the audited mainnet deploy.
 * Addresses are zero; consumers must not point here yet.
 */
export const BASE_MAINNET: NetworkConfig = {
  name: "base-mainnet",
  chainId: 8453,
  rpcUrl: "https://mainnet.base.org",
  blockExplorerUrl: "https://basescan.org",
  lighthouseGateway: "https://gateway.lighthouse.storage/ipfs/",
  addresses: {
    registry: "0x0000000000000000000000000000000000000000",
    reputation: "0x0000000000000000000000000000000000000000",
    registrar: "0x0000000000000000000000000000000000000000",
    protectedSet: "0x0000000000000000000000000000000000000000",
    challengeManager: "0x0000000000000000000000000000000000000000",
    creReceiver: "0x0000000000000000000000000000000000000000",
    usdc: "0x0000000000000000000000000000000000000000",
    l2registry: "0x0000000000000000000000000000000000000000",
  },
};

export function resolveNetwork(input: NetworkPreset | NetworkConfig | undefined): NetworkConfig {
  if (input === undefined || input === "base-sepolia") return BASE_SEPOLIA;
  if (input === "base-mainnet") return BASE_MAINNET;
  if (input === "custom") {
    throw new MissingConfigError(
      "network",
      "preset 'custom' requires a NetworkConfig object, not a string",
    );
  }
  return input;
}
