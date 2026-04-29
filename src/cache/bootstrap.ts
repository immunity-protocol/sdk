import { getAntibodyByImmSeq } from "../settlement/read-antibody.js";
import type { RegistryClient } from "../settlement/registry-client.js";
import { AntibodyNotFoundError } from "../types/errors.js";
import { createLogger } from "../util/logger.js";
import type { AntibodyCache } from "./cache.js";

const log = createLogger("cache:bootstrap");

export interface BootstrapOptions {
  /**
   * Maximum number of concurrent `getAntibodyByImmSeq` reads. Higher means
   * a faster bootstrap but more RPC pressure. Default 4 — well under the
   * 0G testnet's 50 req/s cap when 60 agents start in parallel.
   */
  concurrency?: number;
  /**
   * Soft cap on antibodies to fetch. Useful for staging environments that
   * shouldn't slurp the whole catalog. Default: no cap (fetch all).
   */
  limit?: number;
  /**
   * Skip antibodies whose `immSeq` is already in the cache. Default `true`
   * so a second bootstrap call (e.g., after a reconnect) is cheap.
   */
  skipExisting?: boolean;
}

export interface BootstrapResult {
  /** Total `nextImmSeq` reported by the registry at the time of the call. */
  total: number;
  /** Antibodies successfully fetched and inserted. */
  fetched: number;
  /** Antibodies skipped because they were already in the cache. */
  skipped: number;
  /**
   * Sequence numbers that returned a zero-publisher row from the registry —
   * gaps caused by a slashed/expired antibody, or future-reserved seqs.
   * Counted but not treated as errors.
   */
  missing: number;
}

/**
 * Hydrate `cache` from the on-chain Registry by iterating
 * `getAntibodyByImmSeq(1..nextImmSeq)`.
 *
 * This is the late-joiner story: an SDK consumer that starts after the
 * gossip stream has already aired the catalog cannot reconstruct the cache
 * from gossip alone (gossip is real-time and lossy by design — re-aired
 * messages are not stored). The Registry IS the durable source of truth
 * for the catalog, so we read it directly on `start()`.
 *
 * Side effects: each fetched antibody is `cache.put()`-ed, which fires
 * subscriber notifications that update each Tier-1 matcher's index. Any
 * subsequent `check()` call sees a hot cache.
 *
 * Failure handling: a missing `nextImmSeq` (RPC down, contract not
 * deployed) returns gracefully with all-zero counts — bootstrap should
 * never crash the process. Per-fetch errors are logged and counted; gaps
 * (zero-publisher seqs) are recorded as `missing` and skipped.
 */
export async function bootstrapCacheFromRegistry(
  registry: RegistryClient,
  cache: AntibodyCache,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const skipExisting = opts.skipExisting !== false;

  let total: number;
  try {
    const raw = (await registry.contract.nextImmSeq()) as bigint | number;
    total = Number(raw);
  } catch (err) {
    log.warn("nextImmSeq read failed; skipping bootstrap", { err: String(err) });
    return { total: 0, fetched: 0, skipped: 0, missing: 0 };
  }

  if (total <= 0) {
    log.info("registry empty; nothing to bootstrap");
    return { total: 0, fetched: 0, skipped: 0, missing: 0 };
  }

  const cap = opts.limit ? Math.min(total, opts.limit) : total;
  const seqs = Array.from({ length: cap }, (_, i) => i + 1);

  let fetched = 0;
  let skipped = 0;
  let missing = 0;

  // Bounded concurrency. Sequential within a chunk would be slower; full
  // Promise.all on all seqs at once would slam the RPC. Promise.allSettled
  // means a single transient miss does not abort the whole bootstrap.
  for (let i = 0; i < seqs.length; i += concurrency) {
    const batch = seqs.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (seq) => {
        if (skipExisting && cache.getByImmSeq(seq)) {
          return { kind: "skipped" } as const;
        }
        try {
          const ab = await getAntibodyByImmSeq(registry, seq);
          cache.put(ab);
          return { kind: "fetched" } as const;
        } catch (err) {
          if (err instanceof AntibodyNotFoundError) {
            return { kind: "missing" } as const;
          }
          throw err;
        }
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        log.warn("antibody fetch rejected", { err: String(r.reason) });
        continue;
      }
      if (r.value.kind === "fetched") fetched++;
      else if (r.value.kind === "skipped") skipped++;
      else missing++;
    }
  }

  log.info("bootstrap complete", { total: cap, fetched, skipped, missing });
  return { total: cap, fetched, skipped, missing };
}
