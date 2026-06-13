// Mature the EVIL-token antibody (IMM-2026-0029) the legitimate way, then mirror
// it — so the /dex block has full provenance and the relayer only ever propagates
// an antibody that EARNED enforcement (corroboration >= K), never a raw flag.
//
//   PART 1 (Base Sepolia 84532): grant the deployer reputation so its published
//     antibody counts, derive 2 throwaway publishers, fund + register + grant
//     them reputation, have each publish the SAME matcher (EVIL on chain
//     11155111). That drives corroborationOf >= K=3, then mature() promotes
//     IMM-2026-0029 to ACTIVE / hard-block.
//   PART 2 (Ethereum Sepolia 11155111): only once eligible, clear the earlier
//     hand-set flag and mirror via mirrorAddressAntibody — which sets the real
//     keccakId AND emits AntibodyMirrored so the indexer lights up the antibody
//     detail's "Mirrored to Sepolia" panel.
//
// Run: DEPLOYER_PRIVATE_KEY=… SEPOLIA_RPC_URL=… npx tsx scripts/mature-dex-evil.ts
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, Wallet, NonceManager, Contract, keccak256, toUtf8Bytes, ZeroHash, ZeroAddress } from "ethers";
import { Immunity, BASE_SEPOLIA } from "../src/index.js";
import { hashAddressMatcher } from "../src/keccak/matchers/address.js";
import { computeKeccakId } from "../src/keccak/id.js";
import { ensureGas, ensureUsdc, ensureReputation } from "./seed/funding.js";
import { ensureRegistered, ensureDeposit, publishTarget, keccakIdOf } from "./seed/run.js";
import { buildOnchain } from "./seed/onchain.js";
import { SeedLedger } from "./seed/ledger.js";

loadEnv();

const BASE_RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://eth-sepolia.g.alchemy.com/v2/C5BdobTzYALqWfs3wDc-I";
const REGISTRY = "0x9bD765E191e186679252467Ebbc1D389a59E04B8";
const MIRROR = process.env.MIRROR_ADDRESS ?? "0x6C65b6588B6FE02D33fDc090E6F5432e3Df62fba";
const EVIL = "0xC6dFD5fCb9EB7D210c5D3C5bAB1681094Adfa281".toLowerCase() as `0x${string}`;
const ENFORCEMENT_CHAIN = 11155111;
const THROWAWAYS = 2; // + the deployer (already published) = 3 corroborators = K

const evilInput = {
  seed: { abType: "ADDRESS" as const, chainId: ENFORCEMENT_CHAIN, target: EVIL },
  verdict: "MALICIOUS" as const,
  confidence: 95,
  severity: 90,
  reasonSummary:
    "Designated malicious token for the live Immunity x Uniswap v4 demonstration. The antibody flags this contract's address so any v4 pool gated by the Immunity hook reverts swaps whose token0/token1 (or swapper) is flagged.",
  context:
    "Published on Base (canonical Registry), mirrored to the Ethereum Sepolia enforcement chain where the v4 hook reads it.",
};

const matcherHash = hashAddressMatcher({ chainId: ENFORCEMENT_CHAIN, target: EVIL });
const target = { index: 999, target: EVIL, matcherHash, input: evilInput };

const baseProvider = new JsonRpcProvider(BASE_RPC, 84532);
const deployer = new NonceManager(new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, baseProvider));

function deriveThrowaway(i: number): NonceManager {
  return new NonceManager(
    new Wallet(keccak256(toUtf8Bytes(`${process.env.DEPLOYER_PRIVATE_KEY}:immunity-dex-evil:${i}`)), baseProvider),
  );
}

async function startCtx(label: string, signer: NonceManager) {
  const im = new Immunity({ wallet: signer, network: BASE_SEPOLIA });
  await im.start();
  const address = (await signer.getAddress()).toLowerCase() as `0x${string}`;
  return { label, address, signer, im };
}

(async () => {
  const ledger = new SeedLedger(".dex-evil-ledger.json");
  const { registry: regRead } = buildOnchain(BASE_SEPOLIA, deployer);
  const k = Number(await regRead.corroborationK());
  const repFloor = await regRead.minCorroborationRep();
  const repTarget = repFloor > 100n ? repFloor : 100n;
  const deployerAddr = (await deployer.getAddress()).toLowerCase();
  console.log(`corroborationK=${k}  minCorroborationRep=${repFloor}  repTarget=${repTarget}`);

  // The deployer published IMM-2026-0029; grant it reputation so it counts.
  await ensureReputation(BASE_SEPOLIA, deployer, deployerAddr, repTarget);

  for (let i = 0; i < THROWAWAYS; i++) {
    const signer = deriveThrowaway(i);
    const addr = (await signer.getAddress()).toLowerCase();
    console.log(`\npublisher#${i} ${addr}`);
    await ensureGas(deployer, addr, "0.01", "0.004");
    await ensureUsdc(BASE_SEPOLIA, signer, addr, 50_000_000n, 10_000_000n);
    await ensureReputation(BASE_SEPOLIA, deployer, addr, repTarget);
    const ctx = await startCtx(`dex-evil-${i}`, signer);
    await ensureRegistered(ctx);
    await ensureDeposit(ctx, BASE_SEPOLIA, [target]);
    // The gateway gates evidence writes on PublisherRegistrar.isRegistered, read
    // through its own RPC node. A just-sent registration can lag that node by a
    // few seconds → a 403 "publisher is not registered". Retry through the lag.
    let out;
    for (let attempt = 1; ; attempt++) {
      try {
        out = await publishTarget(ctx, BASE_SEPOLIA, "validate", target, ledger);
        break;
      } catch (e: any) {
        const msg = e?.shortMessage || e?.message || String(e);
        if ((msg.includes("403") || msg.includes("not registered")) && attempt < 6) {
          console.log(`  gateway 403 (registration not yet visible) — retry ${attempt}/5 in 10s`);
          await new Promise((r) => setTimeout(r, 10_000));
          continue;
        }
        throw e;
      }
    }
    console.log(`  published ${out.keccakId} (${out.skipped ?? "new"})`);
  }

  const corroboration = Number(await regRead.corroborationOf(matcherHash));
  console.log(`\ncorroborationOf(EVIL) = ${corroboration} / ${k}`);
  if (corroboration < k) {
    console.error("ABORT: corroboration below K — not mirroring.");
    process.exit(1);
  }

  // Mature the deployer's antibody (IMM-2026-0029) to ACTIVE.
  const deployerKeccak = keccakIdOf(target, deployerAddr as `0x${string}`);
  const reg = new Contract(REGISTRY, [
    "function mature(bytes32)",
    "function getEnforcementInputs(bytes32) view returns (uint8 status, uint16 corroboration, uint256 publisherRep, uint8 prominenceTier, uint64 maturedAt, uint64 expiresAt, bool isSeeded)",
  ], deployer);
  const before = Number((await reg.getEnforcementInputs(deployerKeccak))[0]);
  if (before !== 1) {
    await (await reg.mature(deployerKeccak)).wait();
  }
  const status = Number((await reg.getEnforcementInputs(deployerKeccak))[0]);
  console.log(`IMM-2026-0029 status = ${status} (1 = ACTIVE)`);
  if (status !== 1) {
    console.error("ABORT: not ACTIVE after mature.");
    process.exit(1);
  }

  // PART 2 — now eligible: mirror to Sepolia (clears the earlier hand-set flag,
  // emits AntibodyMirrored). The mirror recomputes keccakId from the envelope.
  const sepoliaProvider = new JsonRpcProvider(SEPOLIA_RPC, ENFORCEMENT_CHAIN);
  const sepoliaWallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, sepoliaProvider);
  const ANTIBODY_TUPLE =
    "tuple(bytes32 primaryMatcherHash,bytes32 evidenceCid,bytes32 contextHash,bytes32 embeddingHash,bytes32 attestation,address publisher,uint64 stakeLockUntil,uint32 immSeq,address reviewer,uint64 expiresAt,uint8 abType,uint8 flavor,uint8 verdict,uint8 confidence,uint64 createdAt,uint96 stakeAmount,uint8 severity,uint8 status,uint8 isSeeded)";
  const mirror = new Contract(MIRROR, [
    `function mirrorAddressAntibody(${ANTIBODY_TUPLE} a, address target)`,
    "function setAddressBlock(address target, bytes32 keccakId)",
    "function isBlocked(address) view returns (bytes32)",
  ], sepoliaWallet);

  // Clear the earlier hand-set synthetic flag so mirrorAddressAntibody writes fresh.
  const current = await mirror.isBlocked(EVIL);
  if (current !== ZeroHash && current.toLowerCase() !== deployerKeccak.toLowerCase()) {
    console.log(`clearing stale flag ${current}`);
    await (await mirror.setAddressBlock(EVIL, ZeroHash)).wait();
  }

  const envelope = {
    primaryMatcherHash: matcherHash, evidenceCid: ZeroHash, contextHash: ZeroHash, embeddingHash: ZeroHash,
    attestation: ZeroHash, publisher: deployerAddr, stakeLockUntil: 0n, immSeq: 0, reviewer: ZeroAddress,
    expiresAt: 0n, abType: 0, flavor: 0, verdict: 2, confidence: 95,
    createdAt: BigInt(Math.floor(Date.now() / 1000)), stakeAmount: 0n, severity: 90, status: 1, isSeeded: 0,
  };
  const tx = await mirror.mirrorAddressAntibody(envelope, EVIL);
  await tx.wait();
  const after = await mirror.isBlocked(EVIL);
  console.log(`\n✅ mirrored EVIL → Sepolia  isBlocked=${after}  tx=${tx.hash}`);
  console.log(`   expected keccakId = ${deployerKeccak}`);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
