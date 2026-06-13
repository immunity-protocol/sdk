// Scenario 3 — a novel malicious target is detected and a NEW antibody is minted.
//
// Mirrors what a publisher/hunter agent does after the CRE Tier-3 screen returns
// MALICIOUS on a never-before-seen drainer: publish() a fresh antibody (posts the
// bond, uploads evidence to the gateway, emits Published). It shows up in the
// dashboard log as a new "Published" event and as a new CVE-style threat row.
//
// Run: DEPLOYER_PRIVATE_KEY=… npx tsx scripts/mint-novel.ts
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { Immunity, BASE_SEPOLIA } from "../src/index.js";

loadEnv();

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REGISTRY = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";

// A novel drainer address NOT in the genesis corpus.
const NOVEL_TARGET = (process.env.NOVEL_TARGET ?? "0xdeadbeef0000000000000000000000000000d1ce").toLowerCase() as `0x${string}`;

(async () => {
  const provider = new JsonRpcProvider(RPC, 84532);
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, provider);

  // Top up the on-chain check/bond balance so publish() can post its bond.
  const usdc = new Contract(USDC, [
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ], wallet);
  const fund = 5_000_000n; // 5 USDC, covers the publish bond with buffer
  await (await usdc.mint(wallet.address, fund)).wait();
  if ((await usdc.allowance(wallet.address, REGISTRY)) < fund) {
    await (await usdc.approve(REGISTRY, fund)).wait();
  }

  const im = new Immunity({ wallet, network: BASE_SEPOLIA });
  await im.start();
  console.log("registered publisher:", await im.isRegistered());
  await im.deposit(fund);
  console.log(`deposited ${Number(fund) / 1e6} USDC for the publish bond`);

  const result = await im.publish({
    seed: { abType: "ADDRESS", chainId: 84532, target: NOVEL_TARGET },
    verdict: "MALICIOUS",
    confidence: 96,
    severity: 90,
    reasonSummary:
      "Novel wallet-drainer flagged by a hunter agent after CRE Tier-3 screening returned MALICIOUS (confidence 96, severity 90).",
    context:
      "Sweeps the full token balance to an attacker EOA on approval; matches the drainer call pattern. Detected on a cache-miss, screened in the CRE TEE.",
  });

  console.log("\n✅ minted new antibody");
  console.log("  threat target :", NOVEL_TARGET);
  console.log("  imm id        :", result.immId);
  console.log("  keccakId      :", result.keccakId);
  console.log("  evidence CID  :", result.evidenceCid);
  console.log("  publish tx    :", result.txHash);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
