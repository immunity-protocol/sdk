// One-shot: open a challenge against a single genesis CRE-demo antibody to drive
// the Layer-1 jury live. Emits ChallengeManager.VerdictRequested(antibodyId,
// evidenceCid) — the jury workflow's log trigger. The genesis targets are real
// OFAC/drainer addresses, so the jury should rule VALID (upheld): the antibody
// is restored and the challenger forfeits the bond. Testnet, recoverable.
//
// Run: DEPLOYER_PRIVATE_KEY=… npx tsx scripts/challenge-one.ts
import { ethers } from "ethers";
import { hashAddressMatcher } from "../src/keccak/matchers/address.js";
import { computeKeccakId } from "../src/keccak/id.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const CHAIN = 84532;
const REGISTRY = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const CHALLENGE_MANAGER = "0xc71c354fFf57652A64b214F654E1A68c7f3cef79";
const USDC = "0xe697EF7724453F239D8c0EB9295D87C344D9CE60";

// Target 0 is a CRE-demo genesis target (encrypted context uploaded for the jury
// to decrypt in-TEE). genesis-1 is one of its three corroborating publishers.
const TARGET = "0x8589427373d6d84e98730d7795d8f6f8731fda16" as `0x${string}`;
const GENESIS_1 = "0x18628A448938aD61C3AAd97Eca1f99DE310684B4" as `0x${string}`;

const p = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, p);

const registry = new ethers.Contract(
  REGISTRY,
  ["function getEnforcementInputs(bytes32) view returns (uint8 status, uint16 corroboration, uint256 publisherRep, uint8 prominenceTier, uint64 maturedAt, uint64 expiresAt, bool isSeeded)"],
  p,
);
const cm = new ethers.Contract(
  CHALLENGE_MANAGER,
  ["function challenge(bytes32)", "function minChallengeBond() view returns (uint256)"],
  w,
);
const usdc = new ethers.Contract(
  USDC,
  ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"],
  w,
);

(async () => {
  const matcherHash = hashAddressMatcher({ chainId: CHAIN, target: TARGET });
  const antibodyId = computeKeccakId("ADDRESS", 0, matcherHash, GENESIS_1);
  const st = Number((await registry.getEnforcementInputs(antibodyId))[0]);
  console.log("antibodyId:", antibodyId, "status:", st, "(1=ACTIVE)");
  if (st !== 1 && st !== 0) throw new Error(`antibody not challengeable (status ${st})`);

  const bond = await cm.minChallengeBond();
  console.log("challenge bond:", bond.toString(), "(6 decimals)");
  await (await usdc.mint(w.address, bond)).wait();
  if ((await usdc.allowance(w.address, CHALLENGE_MANAGER)) < bond) {
    await (await usdc.approve(CHALLENGE_MANAGER, bond)).wait();
  }

  const tx = await cm.challenge(antibodyId);
  const rcpt = await tx.wait();
  console.log("antibodyId:", antibodyId);
  console.log("VerdictRequested tx:", rcpt?.hash);
  console.log(`\nNext: cd ../immunity-cre-workflow && ./simulate.sh ${rcpt?.hash}  (use --evm-event-index 1)`);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
