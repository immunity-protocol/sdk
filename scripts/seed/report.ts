// Human-readable reporting for the seed run.

import { formatUsdc } from "../../src/index.js";
import type { TargetReport } from "./run.js";

function short(hash: string | undefined): string {
  if (!hash) return "—";
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/** The exact command the owner runs to broadcast the full genesis seed. */
export function liveCommand(targetCount: number): string {
  return [
    "DEPLOYER_PRIVATE_KEY=0x… GENESIS_1_PRIVATE_KEY=0x… GENESIS_2_PRIVATE_KEY=0x… \\",
    `  npx tsx scripts/seed-live.ts --live --fund-eth --targets ${targetCount}`,
  ].join("\n");
}

export function printTargetReport(r: TargetReport): void {
  const ok = r.failures.length === 0;
  console.log(
    `\n${ok ? "✓" : "✗"} target #${r.index}  ${r.target}${r.isCreDemo ? "  [CRE-demo]" : ""}`,
  );
  console.log(`   matcher    ${r.matcherHash}`);
  console.log(
    `   corrob.    ${r.corroboration} / k=${r.k}   tier=${r.tier}   evidence-round-trip=${r.evidenceRoundTrip}`,
  );
  for (const p of r.publishers) {
    console.log(
      `   ├─ ${p.label.padEnd(12)} ${p.status.padEnd(9)} keccak=${short(p.keccakId)} cid=${short(p.evidenceCid)}` +
        `${p.contextHash ? ` ctx=${short(p.contextHash)}` : ""}`,
    );
    console.log(
      `   │    publishTx=${short(p.publishTx)}  matureTx=${short(p.matureTx)}  maturedAt=${p.maturedAt}`,
    );
  }
  if (!ok) for (const f of r.failures) console.log(`   ! ${f}`);
}

export interface SummaryOptions {
  mode: "validate" | "live";
  targetCount: number;
  durationMs: number;
}

/** Print the run summary; returns true if every target passed every invariant. */
export function printSummary(reports: TargetReport[], opts: SummaryOptions): boolean {
  const failed = reports.filter((r) => r.failures.length > 0);
  const allOk = failed.length === 0;

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(
    `seed-live ${opts.mode} — ${reports.length} target(s) in ${(opts.durationMs / 1000).toFixed(1)}s`,
  );
  console.log(`  passed: ${reports.length - failed.length}/${reports.length}`);
  if (!allOk) {
    console.log(`  FAILED: ${failed.map((r) => `#${r.index}`).join(", ")}`);
  }

  if (opts.mode === "validate") {
    console.log("\nDry-run validated the full pipeline on Base Sepolia with throwaway wallets.");
    console.log("Stopping before any --live broadcast. The owner runs the genesis seed with:\n");
    console.log(liveCommand(opts.targetCount));
  }
  console.log("──────────────────────────────────────────────────────────────");
  return allOk;
}

export { formatUsdc };
