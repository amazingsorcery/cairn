import { unstable_cache } from "next/cache";

/**
 * Cache tags and the `unstable_cache` discipline. `docs/architecture/caching.md` §4 and §6
 * are the contract; this file is the only place a tag string is constructed, so a typo is a
 * compile error rather than a purge that silently does nothing.
 *
 * The failure mode this file exists to prevent: `revalidateTag("tool:" + slug)` in one file
 * and `tags: ["tools:" + slug]` in another. Both run without error. The cache is never
 * purged. Nobody notices until a reader reports stale content a week later.
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

/** ISR/Data Cache intervals, from caching.md §3. Not invented per call site. */
export const TTL = {
  hour: 3600,
  halfHour: 1800,
  /** `/search` results: an hour of staleness is noticeable here, a minute is not. */
  minute: 60,
} as const;

/**
 * `unstable_cache` with the discipline caching.md §6 requires, in a shape that makes the
 * rules hard to break:
 *
 *   - `keyParts` is a hand-written constant. Arguments are hashed into the key
 *     automatically; interpolating a runtime value into `keyParts` creates an unbounded
 *     number of cache entries and is the standard way to fill a disk.
 *   - Per-entity tags depend on the argument, so they are supplied at call time by a thin
 *     wrapper that closes over the argument (see `cachedByKey`).
 *
 * NEVER wrap a query that takes a `userId`. A workspace row in a shared cache is the worst
 * bug this product can ship, and no type can prevent it — only review. Every function in
 * `lib/queries/workspaces.ts` is deliberately uncached for this reason.
 */
export function cached<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  keyParts: string[],
  options: { tags: string[]; revalidate: number },
): (...args: Args) => Promise<Result> {
  return unstable_cache(fn, keyParts, options);
}

/**
 * A cached read whose tags depend on its argument — the `/tools/[slug]` case. The wrapper
 * closes over the key so the tag list can name the entity, while `keyParts` stays constant
 * and the argument is hashed into the entry key as usual.
 */
export function cachedByKey<Result>(
  fn: (key: string) => Promise<Result>,
  keyParts: string[],
  tagsFor: (key: string) => string[],
  revalidate: number,
): (key: string) => Promise<Result> {
  return (key: string) =>
    unstable_cache(fn, keyParts, { tags: tagsFor(key), revalidate })(key);
}
