import type { Hex32 } from "../types/antibody.js";
import {
  DuplicateAntibodyError,
  InsufficientBalanceError,
  NotRegisteredError,
} from "../types/errors.js";

/**
 * Map a known on-chain revert to a typed SDK error. ethers v6 decodes a
 * contract's custom errors into `err.revert?.name`; we translate the ones the
 * write surface can trigger and rethrow anything else untouched.
 */
export function mapRevert(
  err: unknown,
  ctx: { keccakId?: Hex32; required?: bigint; available?: bigint } = {},
): never {
  const name = (err as { revert?: { name?: string } } | null)?.revert?.name;
  switch (name) {
    case "AntibodyExists":
      throw new DuplicateAntibodyError(ctx.keccakId ?? "unknown");
    case "NotRegistered":
      throw new NotRegisteredError();
    case "InsufficientBalance":
      throw new InsufficientBalanceError(ctx.required ?? 0n, ctx.available ?? 0n);
    default:
      throw err;
  }
}
