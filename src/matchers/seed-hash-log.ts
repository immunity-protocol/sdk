import type { Antibody, Hex32 } from "../types/antibody.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("matchers");

/**
 * A matcher drops any antibody whose recomputed matcher hash does not equal its
 * stored `primaryMatcherHash` (the seed was reconstructed with a wrong field —
 * e.g. a bad SemanticFlavor string↔code mapping at bootstrap). Surfacing the
 * drop here (debug log, namespace `matchers`) keeps a future "bootstrap silently
 * dropped my antibody" bug diagnosable instead of invisible. Enable with
 * `IMMUNITY_DEBUG=matchers`.
 */
export function logSeedHashMismatch(matcher: string, ab: Antibody, expected: Hex32): void {
  log.debug(
    `${matcher}: seed-hash mismatch, dropping antibody ${ab.immId} (${ab.keccakId})`,
    { expected, primaryMatcherHash: ab.primaryMatcherHash },
  );
}
