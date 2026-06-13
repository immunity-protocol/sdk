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
    registry: "0x9bD765E191e186679252467Ebbc1D389a59E04B8",
    reputation: "0x828666a9E2887F8dD03E61b0D9546C32CaDB52d3",
    registrar: "0x762CF28bE7502CC99B6286076e9b4Fb71EE84002",
    protectedSet: "0x95faC80e27419619A9108C53573bf9A77967397A",
    challengeManager: "0xc71c354fFf57652A64b214F654E1A68c7f3cef79",
    creReceiver: "0x02ED0a8b0e6b98C1C05CE125157566313cEe4834",
    novelVerification: "0xe151F9f3cBa23DdDcB7e3379e739F17436488376",
    usdc: "0xe697EF7724453F239D8c0EB9295D87C344D9CE60",
    l2registry: "0xded674AAbCe67B2cFe724c8c50c928830468E0cC",
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
