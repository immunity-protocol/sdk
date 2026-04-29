/**
 * Typed error hierarchy. Every error the SDK throws extends `ImmunityError`,
 * so consumers can either branch on `instanceof` for fine-grained handling
 * or catch-all on the base class.
 *
 * Errors carry a stable `code` string in addition to `name` so log scrapers
 * have something machine-readable that survives minification.
 */
export class ImmunityError extends Error {
  override readonly name: string = "ImmunityError";
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.code = code;
  }
}

export class MissingConfigError extends ImmunityError {
  override readonly name = "MissingConfigError";
  constructor(field: string, hint?: string) {
    const tail = hint ? `: ${hint}` : "";
    super(`required config field missing: ${field}${tail}`, "ERR_MISSING_CONFIG");
  }
}

export class NotStartedError extends ImmunityError {
  override readonly name = "NotStartedError";
  constructor() {
    super("Immunity.start() must be awaited before this call", "ERR_NOT_STARTED");
  }
}

export class BlockError extends ImmunityError {
  override readonly name = "BlockError";
  readonly reason: string;
  constructor(reason: string) {
    super(`action blocked: ${reason}`, "ERR_BLOCKED");
    this.reason = reason;
  }
}

export class EscalationError extends ImmunityError {
  override readonly name = "EscalationError";
  readonly kind: "timeout" | "denied" | "no-handler";
  constructor(kind: "timeout" | "denied" | "no-handler") {
    super(`escalation ${kind}`, `ERR_ESCALATION_${kind.toUpperCase().replace("-", "_")}`);
    this.kind = kind;
  }
}

export class InsufficientBalanceError extends ImmunityError {
  override readonly name = "InsufficientBalanceError";
  readonly required: bigint;
  readonly available: bigint;
  constructor(required: bigint, available: bigint) {
    super(
      `insufficient prepaid USDC: required ${required}, available ${available}`,
      "ERR_INSUFFICIENT_BALANCE",
    );
    this.required = required;
    this.available = available;
  }
}

export class NetworkError extends ImmunityError {
  override readonly name = "NetworkError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ERR_NETWORK", options);
  }
}

export class AntibodyNotFoundError extends ImmunityError {
  override readonly name = "AntibodyNotFoundError";
  constructor(idOrSeq: string | number) {
    super(`antibody not found: ${idOrSeq}`, "ERR_ANTIBODY_NOT_FOUND");
  }
}

export class DuplicateAntibodyError extends ImmunityError {
  override readonly name = "DuplicateAntibodyError";
  readonly keccakId: string;
  constructor(keccakId: string) {
    super(`antibody already exists: ${keccakId}`, "ERR_DUPLICATE_ANTIBODY");
    this.keccakId = keccakId;
  }
}

/**
 * Raised when a different publisher already claims the primary matcher hash
 * the caller wants to publish under. The first publisher keeps the economic
 * claim; the SDK surfaces the existing keccakId so the caller can fetch and
 * reuse it instead of minting a duplicate.
 */
export class MatcherAlreadyClaimedError extends ImmunityError {
  override readonly name = "MatcherAlreadyClaimedError";
  readonly existingKeccakId: string;
  constructor(existingKeccakId: string) {
    super(
      `matcher already claimed by an existing antibody: ${existingKeccakId}`,
      "ERR_MATCHER_ALREADY_CLAIMED",
    );
    this.existingKeccakId = existingKeccakId;
  }
}

export class StakeLockedError extends ImmunityError {
  override readonly name = "StakeLockedError";
  readonly unlockAt: bigint;
  constructor(unlockAt: bigint) {
    super(`stake locked until ${unlockAt}`, "ERR_STAKE_LOCKED");
    this.unlockAt = unlockAt;
  }
}

export class TeeAttestationError extends ImmunityError {
  override readonly name = "TeeAttestationError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(`TEE attestation failed: ${message}`, "ERR_TEE_ATTESTATION", options);
  }
}

export class TeeResponseError extends ImmunityError {
  override readonly name = "TeeResponseError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(`TEE response invalid: ${message}`, "ERR_TEE_RESPONSE", options);
  }
}
