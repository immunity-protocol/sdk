import type { Antibody } from "../types/antibody.js";
import type { AntibodyCache } from "./cache.js";

/**
 * Cache hydration. Decoupled from any specific source: the caller passes
 * an async iterable of antibodies and the cache absorbs them.
 *
 * Concrete sources (chain seq scan, gossip backlog, fixture loader) live
 * next to their own subsystems and produce iterables that feed this loader.
 */
export async function hydrate(
  cache: AntibodyCache,
  source: AsyncIterable<Antibody> | Iterable<Antibody>,
): Promise<number> {
  let count = 0;
  if (Symbol.asyncIterator in source) {
    for await (const ab of source as AsyncIterable<Antibody>) {
      cache.put(ab);
      count++;
    }
  } else {
    for (const ab of source as Iterable<Antibody>) {
      cache.put(ab);
      count++;
    }
  }
  return count;
}
