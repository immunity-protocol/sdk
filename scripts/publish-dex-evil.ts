// Publish the real ADDRESS antibody behind the /dex "EVIL" token so the live
// Uniswap-hook block has provenance: an on-chain Published event on the Base
// Registry → an indexed antibody.entry with an IMM id + detail page → and,
// because its matcher is keccak256(abi.encode(uint256 11155111, address EVIL)),
// every hook-reverted swap attaches to THIS antibody (DexBlockIngestor matches
// by (chainId, target)) and climbs its value-protected.
//
// The matcher's target chain is Ethereum Sepolia (11155111) — where the hook
// enforces — even though the antibody itself is published on Base (84532). That
// IS the cross-chain model: canonical record on Base, enforcement on Sepolia.
//
// After this runs, set the Sepolia Mirror flag to the printed keccakId so the
// hook reverts with the real id (matcher attachment works either way):
//   cast send <MIRROR> "setAddressBlock(address,bytes32)" <EVIL> <keccakId> ...
//
// Run: DEPLOYER_PRIVATE_KEY=… npx tsx scripts/publish-dex-evil.ts
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { Immunity, BASE_SEPOLIA } from "../src/index.js";

loadEnv();

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REGISTRY = "0x7047F4D54A1F4C337BF940cBDee0E68D79B0323b";
const USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";

// The /dex "EVIL" token on Ethereum Sepolia (the protected pool's currency1).
const EVIL = (process.env.DEX_EVIL_TOKEN ?? "0xC6dFD5fCb9EB7D210c5D3C5bAB1681094Adfa281").toLowerCase() as `0x${string}`;
const ENFORCEMENT_CHAIN = 11155111; // where the hook reads the mirror

(async () => {
  const provider = new JsonRpcProvider(RPC, 84532);
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, provider);

  const usdc = new Contract(USDC, [
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ], wallet);
  const fund = 5_000_000n; // 5 USDC — covers the publish bond with buffer
  await (await usdc.mint(wallet.address, fund)).wait();
  if ((await usdc.allowance(wallet.address, REGISTRY)) < fund) {
    await (await usdc.approve(REGISTRY, fund)).wait();
  }

  const im = new Immunity({ wallet, network: BASE_SEPOLIA });
  await im.start();
  console.log("registered publisher:", await im.isRegistered());
  await im.deposit(fund);

  const result = await im.publish({
    seed: { abType: "ADDRESS", chainId: ENFORCEMENT_CHAIN, target: EVIL },
    verdict: "MALICIOUS",
    confidence: 95,
    severity: 90,
    reasonSummary:
      "Designated malicious token for the live Immunity x Uniswap v4 demonstration. The antibody flags this contract's address so any v4 pool gated by the Immunity hook reverts swaps whose token0/token1 (or swapper) is flagged.",
    context:
      "Published on Base (canonical Registry), mirrored to the Ethereum Sepolia enforcement chain where the v4 hook reads it. On testnet this slot is a benign ERC-20 stand-in so judges can mint and swap freely; in production the same flow flags real wallet-drainers surfaced by publisher/hunter agents.",
  });

  console.log("\n✅ published the EVIL-token antibody");
  console.log("  target        :", EVIL, `(chain ${ENFORCEMENT_CHAIN})`);
  console.log("  imm id        :", result.immId);
  console.log("  keccakId      :", result.keccakId);
  console.log("  evidence CID  :", result.evidenceCid);
  console.log("  publish tx    :", result.txHash);
  console.log("\nNext: flag the Sepolia mirror with this keccakId so the hook reverts with the real id.");
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
