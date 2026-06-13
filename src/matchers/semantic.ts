import type { AntibodyCache } from "../cache/cache.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import { type Antibody, type Hex32, isLiveAntibody } from "../types/antibody.js";
import type { MatchHit, MatchProbe, Matcher } from "./matcher.js";
import { flattenContext } from "./semantic-flatten.js";
import { normalizeSemanticText } from "./semantic-normalize.js";
import { logSeedHashMismatch } from "./seed-hash-log.js";

/**
 * SemanticMatcher: v1 marker-substring scan.
 *
 * Each indexed SEMANTIC antibody whose seed carries a `pattern.kind === "marker"`
 * contributes the marker string to a simple lower-cased substring index.
 * Probes are scanned across conversation content, tool args, source text,
 * and counterparty identifiers.
 *
 * Hash-only patterns (`kind === "hash"`) cannot be reverse-searched by
 * markers; they are reachable only via TEE inference (which embeds the
 * probe and compares against the same hash via embedding ANN). v2 will
 * add the embedding pipeline locally; v1 relies on the TEE for novel
 * hash-only matches.
 */
export class SemanticMatcher implements Matcher {
  readonly name = "SEMANTIC";
  readonly priority = 50;

  // marker -> (keccakId -> antibody). Multiple antibodies can share a marker —
  // distinct publishers corroborating, or different flavors hashing to the same
  // normalized string — so each is indexed precisely by `keccakId` and the
  // second never overwrites the first.
  private readonly markers = new Map<string, Map<Hex32, Antibody>>();
  private readonly markerByKeccak = new Map<Hex32, string>();

  attach(cache: AntibodyCache): void {
    for (const ab of cache.values()) this.tryIndex(ab);
    cache.subscribe((kind, ab) => {
      if (kind === "put") this.tryIndex(ab);
      else this.tryUnindex(ab);
    });
  }

  async match(probe: MatchProbe): Promise<MatchHit | null> {
    const haystack = normalizeSemanticText(flattenContext(probe.context));
    if (!haystack) return null;
    // Pick a deterministic winner across every matching marker so results are
    // stable regardless of index/cache ordering. Corroboration rank is a
    // read-side concern not visible here, so the stable tiebreak is the lowest
    // `immSeq` (earliest-minted) LIVE antibody. Block-vs-advisory is decided
    // read-side (classifyEnforcement), so we surface any live antibody here.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let best: { ab: Antibody; marker: string } | null = null;
    for (const [marker, byId] of this.markers) {
      if (!haystack.includes(marker)) continue;
      for (const ab of byId.values()) {
        if (!isLiveAntibody(ab, nowSec)) continue;
        if (!best || ab.immSeq < best.ab.immSeq) best = { ab, marker };
      }
    }
    if (!best) return null;
    return {
      antibody: best.ab,
      matcherName: this.name,
      reason: `semantic marker "${best.marker}" matches ${best.ab.immId}`,
    };
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "SEMANTIC" || !ab.seed || ab.seed.abType !== "SEMANTIC") return;
    const expected = hashSemanticMatcher({
      flavor: ab.seed.flavor,
      pattern: ab.seed.pattern,
    });
    if (expected !== ab.primaryMatcherHash) {
      logSeedHashMismatch(this.name, ab, expected);
      return;
    }
    if (ab.seed.pattern.kind !== "marker") return;
    const marker = normalizeSemanticText(ab.seed.pattern.value);
    let byId = this.markers.get(marker);
    if (!byId) {
      byId = new Map<Hex32, Antibody>();
      this.markers.set(marker, byId);
    }
    byId.set(ab.keccakId, ab);
    this.markerByKeccak.set(ab.keccakId, marker);
  }

  private tryUnindex(ab: Antibody): void {
    const marker = this.markerByKeccak.get(ab.keccakId);
    if (!marker) return;
    const byId = this.markers.get(marker);
    if (byId) {
      byId.delete(ab.keccakId);
      if (byId.size === 0) this.markers.delete(marker);
    }
    this.markerByKeccak.delete(ab.keccakId);
  }
}
