// Drive real check() scenarios on Base Sepolia so the dashboard logs + the
// value-protected counters make sense:
//
//   • HIT / BLOCKED — an agent is about to move USDC in a tx that hits a flagged
//     (genesis) antibody. check() matches → emits Matched(tokenAmount) → the
//     indexer prices it → value_protected_usd rises on the home page + that
//     antibody's detail.
//   • ALLOWED — a legit action that matches nothing → check(0x0) → Checked, no
//     match, allowed (fee to treasury, no value blocked).
//
// The novel-malicious → mint scenario rides the CRE per-check loop separately.
//
// Run: DEPLOYER_PRIVATE_KEY=… npx tsx scripts/scenario-checks.ts
import { ethers } from "ethers";
import { hashAddressMatcher } from "../src/keccak/matchers/address.js";
import { computeKeccakId } from "../src/keccak/id.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const CHAIN = 84532;
const REGISTRY = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";
const GENESIS_1 = "0x18628A448938aD61C3AAd97Eca1f99DE310684B4" as `0x${string}`;

// Genesis flagged targets (each an ACTIVE, hard-block-eligible antibody).
const TARGETS = [
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
] as const;
// USD (== USDC at $1) an agent was about to move toward each drainer → value protected.
const AMOUNTS_USDC = [5_000, 12_500, 3_200];

const p = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, p);

const usdc = new ethers.Contract(USDC, [
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
], w);
const reg = new ethers.Contract(REGISTRY, [
  "function deposit(uint256)",
  "function balances(address) view returns (uint256)",
  "function check(bytes32 antibodyId, address tokenAddress, uint256 tokenAmount, uint256 originChainId) returns (bool)",
  "function getEnforcementInputs(bytes32) view returns (uint8 status, uint16 corroboration, uint256 publisherRep, uint8 prominenceTier, uint64 maturedAt, uint64 expiresAt, bool isSeeded)",
], w);

const six = (n: number) => BigInt(n) * 1_000_000n;

(async () => {
  // 1 — fund the agent's check balance (0.002 USDC/check; 1 USDC = plenty).
  const need = six(1);
  if ((await reg.balances(w.address)) < six(0) + 2_000n * BigInt(TARGETS.length + 1)) {
    await (await usdc.mint(w.address, need)).wait();
    if ((await usdc.allowance(w.address, REGISTRY)) < need) await (await usdc.approve(REGISTRY, need)).wait();
    await (await reg.deposit(need)).wait();
    console.log(`deposited ${ethers.formatUnits(need, 6)} USDC to the check balance`);
  }

  let totalProtected = 0;
  // 2 — HIT / BLOCKED scenarios (value protected rises).
  for (let i = 0; i < TARGETS.length; i++) {
    const mh = hashAddressMatcher({ chainId: CHAIN, target: TARGETS[i] as `0x${string}` });
    const antibodyId = computeKeccakId("ADDRESS", 0, mh, GENESIS_1);
    const st = Number((await reg.getEnforcementInputs(antibodyId))[0]);
    if (st !== 1) { console.log(`skip ${TARGETS[i]} — not ACTIVE (status ${st})`); continue; }
    const amt = six(AMOUNTS_USDC[i]);
    const tx = await reg.check(antibodyId, USDC, amt, CHAIN);
    const r = await tx.wait();
    totalProtected += AMOUNTS_USDC[i];
    console.log(`BLOCKED  $${AMOUNTS_USDC[i].toLocaleString()} → drainer ${TARGETS[i].slice(0, 10)}…  tx ${r?.hash}`);
  }

  // 3 — ALLOWED scenario (legit action, matches nothing).
  const txAllow = await reg.check(ethers.ZeroHash, USDC, six(250), CHAIN);
  const rAllow = await txAllow.wait();
  console.log(`ALLOWED  legit $250 transfer (no antibody match)  tx ${rAllow?.hash}`);

  console.log(`\nTotal value protected this run: $${totalProtected.toLocaleString()}`);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
