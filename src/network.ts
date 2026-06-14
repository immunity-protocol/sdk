import type { Hex } from "./types/antibody.js";
import type { NetworkConfig, NetworkPreset } from "./types/config.js";
import { MissingConfigError } from "./types/errors.js";

/**
 * Placeholder CRE oracle public key (compressed secp256k1, 33 bytes). Used only
 * by Base MAINNET, where the CRE workflow is not yet deployed (testnet-first).
 * Replace with the mainnet oracle key when CRE is deployed there.
 */
const PLACEHOLDER_CRE_ORACLE_PUBKEY =
  "0x020000000000000000000000000000000000000000000000000000000000000000" as Hex;

/**
 * Live Base Sepolia CRE oracle public key (compressed secp256k1). The SDK
 * ECIES-encrypts evidence context to this; only the CRE TEE holds the matching
 * private key (Chainlink Vault DON). Source: the immunity-cre-workflow oracle
 * keypair (ORACLE_PRIVATE_KEY) — verified to derive to this compressed pubkey.
 */
const BASE_SEPOLIA_CRE_ORACLE_PUBKEY =
  "0x0286bb5ddb6912da9d9c7c0d3df9664ac3d6440c1ab0929ae02423d1ce60fe35e5" as Hex;

/**
 * Deployed protocol storage-gateway base URL (signed-POST WRITE target). The
 * SDK POSTs evidence to `{storageGatewayUrl}/evidence`. Shared infra (chain-
 * agnostic — it just pins to IPFS), so both presets reference it.
 */
const STORAGE_GATEWAY_URL = "https://immunity-gateway.fly.dev";

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
  storageGatewayUrl: STORAGE_GATEWAY_URL,
  creOraclePublicKey: BASE_SEPOLIA_CRE_ORACLE_PUBKEY,
  addresses: {
    registry: "0x15F177B17884B991703300C2dcCBA790Dda33fbC",
    reputation: "0x436510F3382F67bDF1eE4B6c4b6f940Eb492b3c4",
    registrar: "0x55237bE657245A6bf223D4b721A72b8e1D2E8523",
    protectedSet: "0x8b20aE052F9391e7b071A262aDa201F2189A1901",
    challengeManager: "0xc05ffEA7657d9F2c8879342cDAa2bE0eF238F04d",
    creReceiver: "0xc4f843aac2C94ce2D349C166d1D8D58cb7049C66",
    novelVerification: "0x0f3733f4683029771E7730288339B460Eb377435",
    usdc: "0xe697EF7724453F239D8c0EB9295D87C344D9CE60",
    l2registry: "0xc647c0693ca93D2Ee5681C2eE7AF02d18C76F3B5",
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
  storageGatewayUrl: STORAGE_GATEWAY_URL,
  creOraclePublicKey: PLACEHOLDER_CRE_ORACLE_PUBKEY,
  addresses: {
    registry: "0x0000000000000000000000000000000000000000",
    reputation: "0x0000000000000000000000000000000000000000",
    registrar: "0x0000000000000000000000000000000000000000",
    protectedSet: "0x0000000000000000000000000000000000000000",
    challengeManager: "0x0000000000000000000000000000000000000000",
    creReceiver: "0x0000000000000000000000000000000000000000",
    novelVerification: "0x0000000000000000000000000000000000000000",
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
