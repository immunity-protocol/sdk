// Cross-chain relayer (one-shot): read the live Base Sepolia ImmunityRegistry's
// hard-block-eligible genesis ADDRESS antibodies and mirror them onto the
// ETHEREUM SEPOLIA Mirror so the antibody-detail "mirrored to Sepolia" view +
// (later) the Sepolia v4 hook see them. This is exactly what bin/relayer.php
// automates; run directly here because the indexer's envelope-buffer enqueue
// isn't populating pending_jobs.
//
//   read  : Base Sepolia (84532)  Registry + ProtectedSet
//   write : Ethereum Sepolia (11155111)  Mirror (deployer = authorized relayer)
//
// Run: DEPLOYER_PRIVATE_KEY=… SEPOLIA_RPC_URL=… npx tsx scripts/mirror-to-sepolia.ts
import { ethers } from "ethers";
import { hashAddressMatcher } from "../src/keccak/matchers/address.js";
import { computeKeccakId } from "../src/keccak/id.js";

const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://eth-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REG = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const PROTECTED_SET = "0x95faC80e27419619A9108C53573bf9A77967397A";
const MIRROR = process.env.MIRROR_ADDRESS ?? "0x6C65b6588B6FE02D33fDc090E6F5432e3Df62fba";
const BASE_CHAIN = 84532; // matcherHash chain (where the antibodies live)
const SEPOLIA_CHAIN = 11155111;
const CORROBORATION_K = 3;

const targets = [
  "0x8589427373d6d84e98730d7795d8f6f8731fda16",
  "0x722122df12d4e14e13ac3b6895a86e84145b6967",
  "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
  "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
  "0x6b75d8af000000e20b7a7ddf000ba900b4009a80",
  "0x000000000035b5e5ad9019092c665357240f594e",
  "0x0000d38a234679f88dd6343d34e26dcb50c30000",
] as const;
const pubs: string[] = [
  "0x18628A448938aD61C3AAd97Eca1f99DE310684B4",
  "0xC325Fa14E5E48708b3e1cB16c6fde9D1bed5758E",
  "0xA1E7E10e89dD7EFAc1e7CbDc34015Ce2A1773060",
];

const pRead = new ethers.JsonRpcProvider(BASE_RPC, BASE_CHAIN);
const pWrite = new ethers.JsonRpcProvider(SEPOLIA_RPC, SEPOLIA_CHAIN);
const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, pWrite);

const reg = new ethers.Contract(REG, ["function getEnforcementInputs(bytes32) view returns (uint8 status, uint16 corroboration, uint256 publisherRep, uint8 prominenceTier, uint64 maturedAt, uint64 expiresAt, bool isSeeded)"], pRead);
const protectedSet = new ethers.Contract(PROTECTED_SET, ["function isProtected(address) view returns (bool)"], pRead);

const ANTIBODY_TUPLE =
  "tuple(bytes32 primaryMatcherHash,bytes32 evidenceCid,bytes32 contextHash,bytes32 embeddingHash,bytes32 attestation,address publisher,uint64 stakeLockUntil,uint32 immSeq,address reviewer,uint64 expiresAt,uint8 abType,uint8 flavor,uint8 verdict,uint8 confidence,uint64 createdAt,uint96 stakeAmount,uint8 severity,uint8 status,uint8 isSeeded)";
const mirror = new ethers.Contract(MIRROR, [
  `function mirrorAddressAntibody(${ANTIBODY_TUPLE} a, address target)`,
  "function isBlocked(address) view returns (bytes32)",
], w);

function envelope(matcherHash: string, publisher: string, isSeeded: boolean) {
  return { primaryMatcherHash: matcherHash, evidenceCid: ethers.ZeroHash, contextHash: ethers.ZeroHash, embeddingHash: ethers.ZeroHash, attestation: ethers.ZeroHash, publisher, stakeLockUntil: 0n, immSeq: 0, reviewer: ethers.ZeroAddress, expiresAt: 0n, abType: 0, flavor: 0, verdict: 0, confidence: 90, createdAt: BigInt(Math.floor(Date.now() / 1000)), stakeAmount: 0n, severity: 80, status: 0, isSeeded: isSeeded ? 1 : 0 };
}

(async () => {
  console.log(`read Base Registry ${REG}  →  write Sepolia Mirror ${MIRROR}  relayer ${w.address}`);
  let eligible = 0, mirrored = 0, skippedProtected = 0;
  for (let t = 0; t < targets.length; t++) {
    const target = targets[t];
    const mh = hashAddressMatcher({ chainId: BASE_CHAIN, target: target as `0x${string}` });
    let chosen: { publisher: string; isSeeded: boolean } | null = null;
    for (const pub of pubs) {
      const kid = computeKeccakId("ADDRESS", 0, mh, pub as `0x${string}`);
      const i = await reg.getEnforcementInputs(kid);
      if (Number(i[0]) === 1 && (Boolean(i[6]) || Number(i[1]) >= CORROBORATION_K)) { chosen = { publisher: pub, isSeeded: Boolean(i[6]) }; break; }
    }
    if (!chosen) { console.log(`  target#${t} ${target}: NOT eligible — skip`); continue; }
    eligible++;
    if (await protectedSet.isProtected(target)) { skippedProtected++; console.log(`  target#${t} ${target}: PROTECTED — leave clear`); continue; }
    if ((await mirror.isBlocked(target)) !== ethers.ZeroHash) { console.log(`  target#${t} ${target}: already mirrored`); mirrored++; continue; }
    const tx = await mirror.mirrorAddressAntibody(envelope(mh, chosen.publisher, chosen.isSeeded), target);
    await tx.wait();
    mirrored++;
    console.log(`  target#${t} ${target}: MIRRORED → Sepolia tx=${tx.hash}`);
  }
  console.log(`\neligible=${eligible}/${targets.length}  mirrored=${mirrored}  skippedProtected=${skippedProtected}`);
  if (eligible === 0) { console.error("ABORT: 0 eligible — derivation wrong, nothing written."); process.exit(1); }
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
