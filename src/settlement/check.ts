import type { Hex32 } from "../types/antibody.js";
import type { RegistryClient } from "./registry-client.js";

const ZERO_BYTES32: Hex32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface CheckSettlementResult {
  txHash: Hex32;
  settled: boolean;
  matched: boolean;
  publisherReward: bigint;
  treasuryReward: bigint;
  sweptCount: number;
  sweptBounty: bigint;
}

/**
 * Submit a `check` to the Registry and parse the resulting receipt.
 *
 * The Registry treats `bytes32(0)` as "no antibody matched": the agent
 * pays the 0.002 USDC fee but the treasury keeps the whole thing. A
 * non-zero `antibodyId` triggers the 80% publisher / 20% treasury split
 * and emits `AntibodyMatched`.
 *
 * Either path opportunistically sweeps up to `SWEEP_BATCH_SIZE` expired
 * stakes; the caller earns `SWEEP_BOUNTY` per release. Both are reported
 * back so the caller can surface earned bounty to the operator.
 */
export async function settleCheck(
  registry: RegistryClient,
  antibodyId: Hex32 | null,
): Promise<CheckSettlementResult> {
  const id = (antibodyId ?? ZERO_BYTES32) as Hex32;
  const tx = await registry.contract.check(id);
  const receipt = await tx.wait();
  if (!receipt) {
    return {
      txHash: tx.hash as Hex32,
      settled: false,
      matched: false,
      publisherReward: 0n,
      treasuryReward: 0n,
      sweptCount: 0,
      sweptBounty: 0n,
    };
  }

  const logs = parseRegistryEvents(registry, receipt.logs ?? []);
  const checkSettled = logs.find((l) => l.name === "CheckSettled");
  const matched = logs.find((l) => l.name === "AntibodyMatched");
  const swept = logs.find((l) => l.name === "StakeSwept");

  return {
    txHash: receipt.hash as Hex32,
    settled: Boolean(checkSettled),
    matched: Boolean(matched),
    publisherReward: matched ? (matched.args.publisherReward as bigint) : 0n,
    treasuryReward: matched ? (matched.args.treasuryReward as bigint) : 0n,
    sweptCount: swept ? Number(swept.args.numReleased as bigint) : 0,
    sweptBounty: swept ? (swept.args.bountyPaid as bigint) : 0n,
  };
}

interface ParsedLog {
  name: string;
  args: Record<string, unknown>;
}

function parseRegistryEvents(
  registry: RegistryClient,
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>,
): ParsedLog[] {
  const out: ParsedLog[] = [];
  for (const log of logs) {
    try {
      const parsed = registry.contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed) {
        const args: Record<string, unknown> = {};
        for (const k of parsed.fragment.inputs.map((i) => i.name)) {
          args[k] = parsed.args[k];
        }
        out.push({ name: parsed.name, args });
      }
    } catch {
      // unrelated logs (e.g. ERC20 Transfer) are skipped
    }
  }
  return out;
}
