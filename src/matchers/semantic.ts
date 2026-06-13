import type { AntibodyCache } from "../cache/cache.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import type { Antibody, Hex32 } from "../types/antibody.js";
import type { MatchHit, MatchProbe, Matcher } from "./matcher.js";
import { flattenContext } from "./semantic-flatten.js";
import { normalizeSemanticText } from "./semantic-normalize.js";

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

  private readonly markers = new Map<string, Antibody>();
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
    for (const [marker, ab] of this.markers) {
      if (ab.status !== "ACTIVE") continue;
      if (haystack.includes(marker)) {
        return {
          antibody: ab,
          matcherName: this.name,
          reason: `semantic marker "${marker}" matches ${ab.immId}`,
        };
      }
    }
    return null;
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "SEMANTIC" || !ab.seed || ab.seed.abType !== "SEMANTIC") return;
    const expected = hashSemanticMatcher({
      flavor: ab.seed.flavor,
      pattern: ab.seed.pattern,
    });
    if (expected !== ab.primaryMatcherHash) return;
    if (ab.seed.pattern.kind !== "marker") return;
    const marker = normalizeSemanticText(ab.seed.pattern.value);
    this.markers.set(marker, ab);
    this.markerByKeccak.set(ab.keccakId, marker);
  }

  private tryUnindex(ab: Antibody): void {
    const marker = this.markerByKeccak.get(ab.keccakId);
    if (!marker) return;
    this.markers.delete(marker);
    this.markerByKeccak.delete(ab.keccakId);
  }
}
