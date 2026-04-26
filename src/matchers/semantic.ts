import type { AntibodyCache } from "../cache/cache.js";
import { hashSemanticMatcher } from "../keccak/matchers/semantic.js";
import type { Antibody, Hex32 } from "../types/antibody.js";
import type { CheckContext } from "../types/context.js";
import type { Matcher, MatchHit, MatchProbe } from "./matcher.js";

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
    const haystack = this.flatten(probe.context).toLowerCase();
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

  private flatten(ctx: CheckContext): string {
    const parts: string[] = [];
    for (const turn of ctx.conversation ?? []) parts.push(turn.content);
    for (const t of ctx.toolTrace ?? []) parts.push(t.tool, JSON.stringify(t.args));
    for (const s of ctx.sources ?? []) {
      parts.push(s.url);
      if (s.extractedText) parts.push(s.extractedText);
    }
    if (ctx.counterparty) {
      parts.push(ctx.counterparty.id);
      if (ctx.counterparty.ens) parts.push(ctx.counterparty.ens);
    }
    return parts.join(" ");
  }

  private tryIndex(ab: Antibody): void {
    if (ab.abType !== "SEMANTIC" || !ab.seed || ab.seed.abType !== "SEMANTIC") return;
    const expected = hashSemanticMatcher({
      flavor: ab.seed.flavor,
      pattern: ab.seed.pattern,
    });
    if (expected !== ab.primaryMatcherHash) return;
    if (ab.seed.pattern.kind !== "marker") return;
    const lower = ab.seed.pattern.value.toLowerCase();
    this.markers.set(lower, ab);
    this.markerByKeccak.set(ab.keccakId, lower);
  }

  private tryUnindex(ab: Antibody): void {
    const marker = this.markerByKeccak.get(ab.keccakId);
    if (!marker) return;
    this.markers.delete(marker);
    this.markerByKeccak.delete(ab.keccakId);
  }
}
