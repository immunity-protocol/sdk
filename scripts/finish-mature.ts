// One-shot: deterministically mature any PROBATION genesis antibody on the new
// core (the seed's retry loop wedged on genesis-3's stragglers). mature() is
// permissionless, so the deployer pokes them. Self-validates: if the known-ACTIVE
// ones don't read ACTIVE, the keccakId derivation is wrong → abort (don't poke).
import { ethers } from "ethers";
import { hashAddressMatcher } from "../src/keccak/matchers/address.js";
import { computeKeccakId } from "../src/keccak/id.js";

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REG = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const CHAIN = 84532;
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
const pubs: Record<string, string> = {
  "genesis-1": "0x18628A448938aD61C3AAd97Eca1f99DE310684B4",
  "genesis-2": "0xC325Fa14E5E48708b3e1cB16c6fde9D1bed5758E",
  "genesis-3": "0xA1E7E10e89dD7EFAc1e7CbDc34015Ce2A1773060",
};

const p = new ethers.JsonRpcProvider(RPC, CHAIN);
const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, p);
const reg = new ethers.Contract(
  REG,
  [
    "function getEnforcementInputs(bytes32) view returns (uint8 status, uint16 corroboration, uint256 publisherRep, uint8 prominenceTier, uint64 maturedAt, uint64 expiresAt, bool isSeeded)",
    "function mature(bytes32)",
  ],
  w,
);

async function scan(): Promise<{ active: number; probation: number }> {
  let active = 0, probation = 0;
  for (let t = 0; t < targets.length; t++) {
    const mh = hashAddressMatcher({ chainId: CHAIN, target: targets[t] as `0x${string}` });
    for (const pub of Object.values(pubs)) {
      const kid = computeKeccakId("ADDRESS", 0, mh, pub as `0x${string}`);
      const s = Number((await reg.getEnforcementInputs(kid))[0]);
      if (s === 1) active++;
      else if (s === 0) probation++;
    }
  }
  return { active, probation };
}

(async () => {
  const before = await scan();
  console.log(`scan: ACTIVE=${before.active}/24  PROBATION=${before.probation}/24`);
  if (before.active === 0) {
    console.error("ABORT: 0 ACTIVE — keccakId derivation wrong, not poking.");
    process.exit(1);
  }
  let poked = 0;
  for (let t = 0; t < targets.length; t++) {
    const mh = hashAddressMatcher({ chainId: CHAIN, target: targets[t] as `0x${string}` });
    for (const [name, pub] of Object.entries(pubs)) {
      const kid = computeKeccakId("ADDRESS", 0, mh, pub as `0x${string}`);
      const i = await reg.getEnforcementInputs(kid);
      if (Number(i[0]) === 0 && Number(i[1]) >= 3) {
        const tx = await reg.mature(kid);
        await tx.wait();
        poked++;
        console.log(`matured target#${t} ${name} → ${tx.hash}`);
      }
    }
  }
  const after = await scan();
  console.log(`\npoked=${poked}; FINAL ACTIVE=${after.active}/24  PROBATION=${after.probation}/24`);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
