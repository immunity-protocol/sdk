import type { Hex32 } from "../types/antibody.js";
import type { RegistryClient } from "./registry-client.js";

export interface SweepResult {
  txHash: Hex32;
  released: number;
  bountyPaid: bigint;
}

/**
 * Standalone sweep call. Releases up to `SWEEP_BATCH_SIZE = 5` expired
 * stakes back to their publishers and pays the caller `SWEEP_BOUNTY` per
 * release, drawn from the treasury balance.
 *
 * The same sweep runs opportunistically inside `check()`, so most users
 * will never need to call this directly. Useful as a keeper bounty
 * earner for users who don't issue checks frequently.
 */
export async function sweepExpired(registry: RegistryClient): Promise<SweepResult> {
  const tx = await registry.contract.sweepExpired();
  const receipt = await tx.wait();
  const swept = (receipt?.logs ?? [])
    .map((l: { topics: ReadonlyArray<string>; data: string }) => {
      try {
        return registry.contract.interface.parseLog({
          topics: [...l.topics],
          data: l.data,
        });
      } catch {
        return null;
      }
    })
    .find((l: { name: string } | null) => l?.name === "StakeSwept");
  return {
    txHash: (receipt?.hash ?? tx.hash) as Hex32,
    released: swept ? Number(swept.args.numReleased as bigint) : 0,
    bountyPaid: swept ? (swept.args.bountyPaid as bigint) : 0n,
  };
}
