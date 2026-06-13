import type { EnforcementInputs } from "../types/enforcement.js";

export type EnforcementTier = "hard-block" | "advisory" | "none";

/**
 * The two-speed enforcement rule, as a pure function.
 *
 * Hard-block IFF `corroboration >= k` OR `isSeeded`; otherwise advisory. Dead
 * antibodies (SLASHED/EXPIRED/past-TTL) are neither — they return `none`.
 *
 * It deliberately does NOT branch on `status === "ACTIVE"`: a later maturation
 * pass can reach ACTIVE via time/volume WITHOUT corroboration, and that must
 * never grant censorship power. So an ACTIVE-but-uncorroborated antibody is
 * advisory, and CHALLENGED falls out correctly for free — corroborated/seeded
 * stays hard-block during a challenge, uncorroborated is advisory.
 */
export function classifyEnforcement(
  i: EnforcementInputs,
  k: number,
  nowSec: bigint,
): EnforcementTier {
  if (i.status === "SLASHED" || i.status === "EXPIRED") return "none";
  if (i.expiresAt !== 0n && i.expiresAt <= nowSec) return "none";
  if (i.isSeeded || i.corroboration >= k) return "hard-block";
  return "advisory";
}
