import type { AntibodyCache } from "../cache/cache.js";
import type { Antibody } from "../types/antibody.js";
import type { CheckContext, ProposedTx } from "../types/context.js";

export interface MatchProbe {
  tx: ProposedTx | null;
  context: CheckContext;
}

export interface MatchHit {
  antibody: Antibody;
  matcherName: string;
  reason: string;
}

/**
 * Local-cache matcher. Implementations subscribe to an `AntibodyCache`
 * via `attach()` to maintain their own type-specific indices, and answer
 * `match()` from those indices without touching the cache directly.
 *
 * `priority` orders matchers cheap-first inside the registry: a successful
 * hit short-circuits the rest. Conventional values:
 *   10 ADDRESS / 20 CALL_PATTERN / 30 GRAPH / 40 BYTECODE / 50 SEMANTIC.
 */
export interface Matcher {
  readonly name: string;
  readonly priority: number;
  attach(cache: AntibodyCache): void;
  match(probe: MatchProbe): Promise<MatchHit | null>;
}

/**
 * Holds a priority-ordered list of matchers and runs them first-hit-wins.
 *
 * The registry does not own the cache: each matcher attaches itself to
 * the cache during SDK startup. The registry is purely the dispatch lane.
 */
export class MatcherRegistry {
  private readonly matchers: Matcher[] = [];

  register(matcher: Matcher): void {
    this.matchers.push(matcher);
    this.matchers.sort((a, b) => a.priority - b.priority);
  }

  list(): readonly Matcher[] {
    return this.matchers;
  }

  async matchFirst(probe: MatchProbe): Promise<MatchHit | null> {
    for (const m of this.matchers) {
      const hit = await m.match(probe);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Run every matcher and collect all hits. Unlike `matchFirst`, this does NOT
   * short-circuit on the first hit: a cheap ADDRESS hit must not hide a costlier
   * BYTECODE hit that classifies hard-block. The enforcement resolver classifies
   * each hit and takes the strongest tier — under-classifying (less protection)
   * is the wrong failure mode for a security tool.
   */
  async matchAll(probe: MatchProbe): Promise<MatchHit[]> {
    const hits: MatchHit[] = [];
    for (const m of this.matchers) {
      const hit = await m.match(probe);
      if (hit) hits.push(hit);
    }
    return hits;
  }
}
