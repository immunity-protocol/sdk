import type { RawVerdict } from "../tee/parse.js";
import type { CheckContext, ProposedTx } from "../types/context.js";

/**
 * Tier-3 novel-input verifier port.
 *
 * `check()` calls this on the `verify` (novel) and `corroborate` (advisory)
 * paths to get a fresh verdict for an input neither the cache nor the chain
 * recognizes. S5 only DEFINES and CALLS the port; the concrete CRE/TEE-backed
 * implementation is S6. When no verifier is injected, or it throws or times
 * out, the orchestrator fails CLOSED — it never silently allows.
 */
export interface NovelVerifier {
  verify(input: { tx: ProposedTx | null; context: CheckContext }): Promise<RawVerdict>;
}

/** Raised when a `withTimeout`-wrapped operation exceeds its budget. */
export class OperationTimeoutError extends Error {
  override readonly name = "OperationTimeoutError";
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
  }
}

/**
 * Race a promise against a timeout. When `ms` is falsy (0 / undefined) the work
 * is awaited as-is with no timer. On timeout the returned promise REJECTS with
 * an `OperationTimeoutError` so callers on the verify/escalate paths can fail
 * closed. The timer is always cleared so a slow-but-eventual result never leaks
 * a dangling handle.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number | undefined,
  label: string,
): Promise<T> {
  if (!ms || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
