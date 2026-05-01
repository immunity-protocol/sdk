import { fetchPublicEnvelope } from "../storage/envelope.js";
import type { StorageClient } from "../storage/indexer.js";
import { getAntibodyByImmSeq } from "../settlement/read-antibody.js";
import type { RegistryClient } from "../settlement/registry-client.js";
import type { Antibody } from "../types/antibody.js";
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
  /**
   * Retry transient per-fetch failures (RPC throttling, occasional
   * `missing revert data` blips on under-replicated read nodes) up to N
   * times with exponential backoff. Default 3 — three retries handles the
   * 50-agent thundering-herd against the 0G testnet's 50 req/s cap without
   * inflating the bootstrap latency for happy-path runs.
   */
  fetchRetries?: number;
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

export interface BootstrapDeps {
  registry: RegistryClient;
  cache: AntibodyCache;
  /**
   * Optional 0G storage client. When provided, bootstrap fetches the
   * public envelope for each antibody and reconstructs the seed (for
   * ADDRESS type) so the AddressMatcher can index it. Without storage,
   * antibodies hydrate seedless and Tier-1 lookups never find them —
   * the original "bootstrap helps the cache stay populated but never
   * actually fires" bug we hit running 60 agents against a registry
   * full of pre-published genesis antibodies.
   */
  storage?: StorageClient;
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
  storage?: StorageClient,
): Promise<BootstrapResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const skipExisting = opts.skipExisting !== false;
  const fetchRetries = Math.max(0, opts.fetchRetries ?? 3);

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
        return fetchOneWithRetry(registry, cache, seq, fetchRetries, storage);
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

type FetchOutcome =
  | { kind: "fetched" }
  | { kind: "skipped" }
  | { kind: "missing" };

/**
 * Single-seq fetch with exponential backoff. The 0G testnet's public RPC
 * fans out reads across replicas with eventually-consistent state; under
 * heavy load it occasionally returns CALL_EXCEPTION ("missing revert data")
 * for valid seqs. We treat any non-{@link AntibodyNotFoundError} failure as
 * transient and retry. After exhausting retries we re-throw so the caller
 * logs and counts the failure rather than silently ignoring it.
 */
async function fetchOneWithRetry(
  registry: RegistryClient,
  cache: AntibodyCache,
  seq: number,
  maxRetries: number,
  storage?: StorageClient,
): Promise<FetchOutcome> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ab = await getAntibodyByImmSeq(registry, seq);
      const enriched = storage ? await tryEnrichWithSeed(ab, storage) : ab;
      cache.put(enriched);
      return { kind: "fetched" };
    } catch (err) {
      if (err instanceof AntibodyNotFoundError) {
        return { kind: "missing" };
      }
      lastErr = err;
      if (attempt < maxRetries) {
        const backoff = 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
  }
  throw lastErr;
}

/**
 * Reconstruct the seed for ADDRESS-type antibodies from their public 0G
 * storage envelope. The Registry contract stores only `primaryMatcherHash`,
 * so a chain-only fetch yields a seedless antibody — the AddressMatcher
 * silently drops it during indexing and Tier-1 lookups never fire. The
 * envelope's `matcher` summary publicly exposes the address target, so
 * we can rebuild the seed without leaking anything that wasn't already
 * public. SEMANTIC envelopes intentionally redact the marker text (only a
 * `markerHint` is exposed) — those antibodies still need a live gossip
 * arrival to populate their seed; we leave them seedless on bootstrap.
 *
 * Best-effort: a storage fetch failure (0G indexer down, missing CID)
 * returns the original seedless antibody so bootstrap never fails over a
 * single envelope. The future `gossip.notify` for the same keccakId can
 * still upgrade the entry to seeded.
 */
async function tryEnrichWithSeed(
  ab: Antibody,
  storage: StorageClient,
): Promise<Antibody> {
  if (ab.seed || ab.evidenceCid === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    return ab;
  }
  try {
    const env = await fetchPublicEnvelope(storage, ab.evidenceCid);
    if (env.matcher.kind === "address") {
      return {
        ...ab,
        seed: { abType: "ADDRESS", chainId: env.matcher.chainId, target: env.matcher.target },
      };
    }
    if (env.matcher.kind === "semantic" && env.matcher.markerHint) {
      // The envelope publishes a 64-char prefix of the marker (intentional —
      // see settlement/publish.ts envelopeMatcherFor). For SemanticMatcher
      // substring scanning that prefix is usually enough: incident content
      // bundles the canonical marker verbatim, and the prefix is rare enough
      // that it doesn't false-positive on benign text. SEMANTIC antibodies
      // whose full markers exceed 64 chars match only on the prefix until a
      // live gossip arrival upgrades the seed; that's an acceptable
      // demo-time concession over having no SEMANTIC matches at all.
      const flavor = env.matcher.flavor as
        | "instruction"
        | "behavior"
        | "context"
        | "tooluse"
        | "claim";
      return {
        ...ab,
        seed: {
          abType: "SEMANTIC",
          flavor,
          pattern: { kind: "marker", value: env.matcher.markerHint.toLowerCase() },
        },
      };
    }
    return ab;
  } catch (err) {
    log.warn("envelope fetch failed during bootstrap; antibody hydrates seedless", {
      imm_seq: ab.immSeq,
      evidence_cid: ab.evidenceCid,
      err: String(err).slice(0, 200),
    });
    return ab;
  }
}
