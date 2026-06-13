import type { Status } from "./antibody.js";

/**
 * The read-side enforcement inputs the Registry exposes via
 * `getEnforcementInputs(antibodyId)`. The SDK/Hook derive hard-block
 * eligibility from these — `corroboration >= K OR isSeeded` — and NEVER from
 * `status === "ACTIVE"` (a later pass can reach ACTIVE via time/volume
 * maturation without corroboration, which must not grant censorship power).
 */
export interface EnforcementInputs {
  status: Status;
  /** Distinct reputable publishers flagging the matcher (live count). */
  corroboration: number;
  /** Current reputation score of the antibody's publisher. */
  publisherRep: bigint;
  /** 0 = normal target, 1 = protected (blue-chip) target. */
  prominenceTier: number;
  /** Unix seconds the antibody matured; 0 if not matured. */
  maturedAt: bigint;
  /** Unix seconds TTL; 0 = permanent. */
  expiresAt: bigint;
  /** True for genesis-seeded antibodies (hard-block-eligible at launch). */
  isSeeded: boolean;
}
