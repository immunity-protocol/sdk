// Immunity live-seed script.
//
// Bootstraps the deployed Base Sepolia network from zero antibodies to a
// testable state: 3 genesis publishers each publish the same known-bad corpus
// targets, driving corroborationOf == 3 (corroborationK) so the antibodies
// mature to ACTIVE and become hard-block-eligible. Evidence is uploaded through
// the live gateway, producing real CIDs; CRE-demo targets carry ECIES-encrypted
// context to the CRE oracle.
//
// Modes:
//   validate (default) — real Base Sepolia, 3 throwaway wallets, 1 target. Used
//     to prove the whole pipeline + corroboration path before the owner runs the
//     genesis seed. Throwaway wallets self-mint USDC, are funded gas by the
//     deployer, and are granted reputation by the deployer (Reputation owner) so
//     they count toward corroboration (minCorroborationRep gate).
//   --live (owner only) — real Base Sepolia, 3 genesis keys, the first-N corpus.
//     Deployer mints USDC to each genesis; --fund-eth tops up gas. Genesis
//     wallets already hold reputation, so no grant.
//
// Idempotent/resumable: skips already-registered publishers, already-published
// antibodies (ledger + on-chain check), and already-ACTIVE antibodies.
//
// Usage:
//   DEPLOYER_PRIVATE_KEY=0x… npx tsx scripts/seed-live.ts            # validate
//   DEPLOYER_PRIVATE_KEY=0x… GENESIS_1_PRIVATE_KEY=0x… \
//     GENESIS_2_PRIVATE_KEY=0x… npx tsx scripts/seed-live.ts --live  # genesis

import { config as loadEnv } from "dotenv";
import { JsonRpcProvider, NonceManager, type Signer, Wallet, keccak256, toUtf8Bytes } from "ethers";
import {
  type Address,
  BASE_SEPOLIA,
  Immunity,
  type NetworkConfig,
  formatUsdc,
} from "../src/index.js";
import { type CorpusTarget, loadCorpus, loadValidateTarget } from "./seed/corpus.js";
import { ensureGas, ensureReputation, ensureUsdc, fmtEth } from "./seed/funding.js";
import { DEFAULT_LEDGER_PATH, SeedLedger } from "./seed/ledger.js";
import { buildOnchain } from "./seed/onchain.js";
import { printSummary, printTargetReport } from "./seed/report.js";
import {
  type PublisherCtx,
  type TargetReport,
  ensureDeposit,
  ensureRegistered,
  matureAndAssert,
  publishTarget,
  readStorage,
} from "./seed/run.js";
import { depositTarget, mintTarget } from "./seed/sizing.js";

loadEnv();

const GAS_TOPUP_ETH = "0.004";
const GAS_MIN_ETH = "0.002";

interface Args {
  live: boolean;
  fundEth: boolean;
  targets: number;
  validateIndex: number;
  corpus: string | undefined;
  ledger: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    live: false,
    fundEth: false,
    targets: 8,
    validateIndex: 12,
    corpus: undefined,
    ledger: DEFAULT_LEDGER_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--live":
        args.live = true;
        break;
      case "--fund-eth":
        args.fundEth = true;
        break;
      case "--targets":
        args.targets = Number(argv[++i]);
        break;
      case "--validate-index":
        args.validateIndex = Number(argv[++i]);
        break;
      case "--corpus":
        args.corpus = argv[++i];
        break;
      case "--ledger":
        args.ledger = argv[++i] ?? DEFAULT_LEDGER_PATH;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

/**
 * Deterministic throwaway publisher, NonceManager-wrapped. Derived from the
 * deployer key so a resumed run reuses the same wallets (no stranded funds).
 */
function deriveThrowaway(deployerPk: string, i: number, provider: JsonRpcProvider): NonceManager {
  const wallet = new Wallet(
    keccak256(toUtf8Bytes(`${deployerPk}:immunity-seedtest:${i}`)),
    provider,
  );
  return new NonceManager(wallet);
}

/** Per-publisher USDC sizing (same across publishers — bonds depend only on severity+target). */
async function sizeFunding(
  net: NetworkConfig,
  runner: Signer,
  targets: CorpusTarget[],
): Promise<{ registrationBond: bigint; deposit: bigint; mint: bigint }> {
  const { registrar, registry } = buildOnchain(net, runner);
  const registrationBond = await registrar.registrationBond();
  const bonds: bigint[] = [];
  for (const t of targets) bonds.push(await registry.computeBond(t.input.severity, t.target));
  const deposit = depositTarget(bonds);
  const mint = mintTarget(registrationBond, deposit);
  return { registrationBond, deposit, mint };
}

/** Register → deposit → publish all targets for one publisher. */
async function seedPublisher(
  ctx: PublisherCtx,
  net: NetworkConfig,
  mode: string,
  targets: CorpusTarget[],
  ledger: SeedLedger,
): Promise<void> {
  const reg = await ensureRegistered(ctx);
  console.log(
    `  ${ctx.label} (${ctx.address}) ${reg.alreadyRegistered ? "already registered" : `registered tx=${reg.txHash}`}`,
  );
  const dep = await ensureDeposit(ctx, net, targets);
  console.log(
    `  ${ctx.label} balance ${formatUsdc(dep.have)} / need ${formatUsdc(dep.needed)} USDC${dep.txHash ? ` deposit tx=${dep.txHash}` : ""}`,
  );
  for (const t of targets) {
    const out = await publishTarget(ctx, net, mode, t, ledger);
    const how = out.skipped ? `skipped (${out.skipped})` : `tx=${out.txHash}`;
    console.log(`    publish #${t.index} ${t.target} → ${how}`);
  }
}

/** Mature + assert every target across all publishers; collect reports. */
async function assertTargets(
  net: NetworkConfig,
  readsRunner: Signer,
  ctxs: PublisherCtx[],
  targets: CorpusTarget[],
  ledger: SeedLedger,
  mode: string,
): Promise<TargetReport[]> {
  const storage = readStorage(net, readsRunner);
  const reports: TargetReport[] = [];
  for (const t of targets) {
    reports.push(await matureAndAssert(net, readsRunner, ctxs, t, ledger, mode, storage));
  }
  return reports;
}

async function startCtx(net: NetworkConfig, label: string, signer: Signer): Promise<PublisherCtx> {
  const im = new Immunity({ wallet: signer, network: "base-sepolia" });
  await im.start();
  const address = (await signer.getAddress()).toLowerCase() as Address;
  return { label, address, signer, im };
}

async function runValidate(
  net: NetworkConfig,
  provider: JsonRpcProvider,
  args: Args,
): Promise<boolean> {
  const deployerPk = requireEnv("DEPLOYER_PRIVATE_KEY");
  const deployer = new NonceManager(new Wallet(deployerPk, provider));
  const ledger = new SeedLedger(args.ledger);
  const mode = "validate";

  const target = loadValidateTarget({
    ...(args.corpus ? { path: args.corpus } : {}),
    index: args.validateIndex,
  });
  const targets = [target];
  console.log(
    `\nvalidate mode — 1 target (#${target.index} ${target.target}), 3 throwaway publishers\n`,
  );

  // Reputation gate: throwaway wallets start at score 0 and must be granted
  // reputation >= minCorroborationRep to count toward corroboration.
  const repFloor = await buildOnchain(net, deployer).registry.minCorroborationRep();
  const repTarget = repFloor > 100n ? repFloor : 100n;
  const { registrationBond, deposit, mint } = await sizeFunding(net, deployer, targets);
  const usdcMin = registrationBond + deposit;
  console.log(
    `  per-publisher: registrationBond=${formatUsdc(registrationBond)} deposit=${formatUsdc(deposit)} mint=${formatUsdc(mint)} USDC; repTarget=${repTarget}`,
  );

  const ctxs: PublisherCtx[] = [];
  for (let i = 0; i < 3; i++) {
    const signer = deriveThrowaway(deployerPk, i, provider);
    const addr = await signer.getAddress();

    const gas = await ensureGas(deployer, addr, GAS_TOPUP_ETH, GAS_MIN_ETH);
    console.log(
      `  seedtest-${i} ${addr} gas=${fmtEth(gas.balance)} ETH${gas.txHash ? ` (funded tx=${gas.txHash})` : ""}`,
    );

    const rep = await ensureReputation(net, deployer, addr, repTarget);
    if (rep.granted) console.log(`    granted reputation → ${rep.score} (tx=${rep.txHash})`);

    // The throwaway self-mints with its own NonceManager (same signer the SDK uses).
    const minted = await ensureUsdc(net, signer, addr, mint, usdcMin);
    if (minted.minted)
      console.log(`    minted USDC → ${formatUsdc(minted.balance)} (tx=${minted.txHash})`);

    ctxs.push(await startCtx(net, `seedtest-${i}`, signer));
  }

  for (const ctx of ctxs) await seedPublisher(ctx, net, mode, targets, ledger);

  const reports = await assertTargets(net, deployer, ctxs, targets, ledger, mode);
  for (const r of reports) printTargetReport(r);
  return printSummary(reports, { mode, targetCount: args.targets, durationMs: 0 });
}

async function runLive(
  net: NetworkConfig,
  provider: JsonRpcProvider,
  args: Args,
): Promise<boolean> {
  // genesis-1 IS the deployer; it reuses the SAME NonceManager for both funding
  // and publishing so the two roles share one local nonce sequence.
  const deployer = new NonceManager(new Wallet(requireEnv("DEPLOYER_PRIVATE_KEY"), provider));
  const g1 = new NonceManager(new Wallet(requireEnv("GENESIS_1_PRIVATE_KEY"), provider));
  const g2 = new NonceManager(new Wallet(requireEnv("GENESIS_2_PRIVATE_KEY"), provider));
  const wallets: Array<{ label: string; signer: Signer }> = [
    { label: "genesis-1", signer: deployer },
    { label: "genesis-2", signer: g1 },
    { label: "genesis-3", signer: g2 },
  ];
  const ledger = new SeedLedger(args.ledger);
  const mode = "live";

  const targets = loadCorpus({
    ...(args.corpus ? { path: args.corpus } : {}),
    count: args.targets,
    creDemoCount: 2,
  });
  console.log(`\nlive mode — ${targets.length} targets × 3 genesis publishers\n`);

  const { registrationBond, deposit, mint } = await sizeFunding(net, deployer, targets);
  const usdcMin = registrationBond + deposit;
  console.log(
    `  per-publisher: registrationBond=${formatUsdc(registrationBond)} deposit=${formatUsdc(deposit)} mint=${formatUsdc(mint)} USDC`,
  );

  const { reputation } = buildOnchain(net, deployer);
  const ctxs: PublisherCtx[] = [];
  for (const { label, signer } of wallets) {
    const addr = await signer.getAddress();
    const isDeployer = signer === deployer;
    const score = await reputation.scoreOf(addr);
    console.log(`  ${label} ${addr} reputation=${score}`);

    if (args.fundEth && !isDeployer) {
      const gas = await ensureGas(deployer, addr, GAS_TOPUP_ETH, GAS_MIN_ETH);
      if (gas.txHash) console.log(`    funded gas → ${fmtEth(gas.balance)} ETH (tx=${gas.txHash})`);
    }
    // Deployer mints USDC to each genesis wallet (mint is permissionless).
    const minted = await ensureUsdc(net, deployer, addr, mint, usdcMin);
    if (minted.minted)
      console.log(`    minted USDC → ${formatUsdc(minted.balance)} (tx=${minted.txHash})`);

    ctxs.push(await startCtx(net, label, signer));
  }

  for (const ctx of ctxs) await seedPublisher(ctx, net, mode, targets, ledger);

  const reports = await assertTargets(net, deployer, ctxs, targets, ledger, mode);
  for (const r of reports) printTargetReport(r);
  return printSummary(reports, { mode, targetCount: targets.length, durationMs: 0 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const net = BASE_SEPOLIA;
  const provider = new JsonRpcProvider(net.rpcUrl, net.chainId);
  const start = Date.now();

  const ok = args.live
    ? await runLive(net, provider, args)
    : await runValidate(net, provider, args);

  console.log(`\nelapsed ${((Date.now() - start) / 1000).toFixed(1)}s`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error("seed-live failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
