import { unstable_cache } from "next/cache";

/**
 * Cache tags and `unstable_cache` helpers. Tag strings are only built here, so a mismatched
 * tag between `revalidateTag` and `tags` can't silently skip a purge.
 */

export const TAG = {
  tools: "tools",
  playbooks: "playbooks",
  categories: "categories",
  tags: "tags",
  search: "search",
  connectors: "connectors",
  cameras: "cameras",

  tool: (slug: string) => `tool:${slug}`,
  playbook: (slug: string) => `playbook:${slug}`,
  category: (slug: string) => `category:${slug}`,
  tag: (slug: string) => `tag:${slug}`,
  camera: (slug: string) => `camera:${slug}`,
} as const;

/** ISR/Data Cache intervals, in seconds. */
export const TTL = {
  hour: 3600,
  halfHour: 1800,
  /** `/search` results. */
  minute: 60,
} as const;

/**
 * `unstable_cache` wrapper. `keyParts` must be a constant (arguments are hashed in
 * automatically); for per-entity tags use `cachedByKey`.
 *
 * Never wrap a query that takes a `userId`; that would put private rows in a shared cache.
 */
export function cached<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  keyParts: string[],
  options: { tags: string[]; revalidate: number },
): (...args: Args) => Promise<Result> {
  const memoised = unstable_cache(fn, keyParts, options);
  return async (...args: Args) => {
    try {
      return await memoised(...args);
    } catch (error) {
      if (!isMissingCacheContext(error)) throw error;
      // No Next.js cache context (e.g. a script): read through uncached.
      return fn(...args);
    }
  };
}

/**
 * Matches `Invariant: incrementalCache missing in unstable_cache`, thrown outside a request
 * or build (e.g. `db/seed.ts`). Matched narrowly so real errors from `fn` still propagate.
 */
function isMissingCacheContext(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("incrementalCache") &&
    error.message.includes("unstable_cache")
  );
}

/** A cached read whose tags depend on its argument (e.g. `/tools/[slug]`). */
export function cachedByKey<Result>(
  fn: (key: string) => Promise<Result>,
  keyParts: string[],
  tagsFor: (key: string) => string[],
  revalidate: number,
): (key: string) => Promise<Result> {
  return (key: string) => cached(fn, keyParts, { tags: tagsFor(key), revalidate })(key);
}
