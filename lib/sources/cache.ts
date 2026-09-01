import type { z } from "zod";

import type { SourceCache } from "./types";

/**
 * Helpers over the `SourceCache` handed to an adapter in `SourceContext`.
 *
 * The cache is deliberately narrow — `get`/`set` on strings — so an adapter cannot enumerate
 * or flush entries that are not its own, and so a test can hand over a plain map. These
 * helpers add the two things
 * every caller would otherwise reimplement: JSON round-tripping validated by a schema, and a
 * namespaced key so two sources cannot collide.
 *
 * **A cache read is never allowed to fail a poll.** A malformed or unreachable entry returns
 * `null` and the adapter proceeds as if cold. The cache is an optimisation over a side-fetch;
 * treating it as a source of truth is how a stale entry becomes a permanent wrong answer.
 */

/** Namespaced so two adapters cannot collide on a key like `zones`. */
export function cacheKey(slug: string, name: string): string {
  return `source:${slug}:${name}`;
}

/**
 * Read and validate a cached JSON value.
 *
 * The schema matters more here than it looks: a cache entry written by an OLDER build of this
 * code is exactly as much of an unvalidated boundary as an upstream response, and it outlives
 * a deploy. Validating on read is what stops a shape change in our own code becoming a
 * crash on the first poll after release.
 */
export async function getJson<S extends z.ZodTypeAny>(
  cache: SourceCache,
  key: string,
  schema: S,
): Promise<z.infer<S> | null> {
  let raw: string | null;
  try {
    raw = await cache.get(key);
  } catch {
    // A cache that is down is a cache miss, not an outage.
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed = schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write a JSON value. A failed write is not an error worth failing a poll over. */
export async function setJson(
  cache: SourceCache,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  try {
    await cache.set(key, JSON.stringify(value), ttlSeconds);
  } catch {
    // Deliberately swallowed: we already have the data we were caching.
  }
}

/**
 * An in-process `SourceCache`.
 *
 * For tests and for a healthcheck run from a CLI. **A per-process map is also what production
 * uses** — `app/(public)/map/sources.ts` builds an equivalent one over its own `Map` — and
 * this comment used to say the opposite: "explicitly NOT the production path... the fallback
 * when no Redis is configured". ADR 0031 removed the `redis` container and QV-31 records the
 * sentences that outlived it.
 *
 * What that costs is real and belongs next to the code rather than in a runbook: nothing here
 * survives a restart, so after a deploy the NWS zone centroids are re-resolved over several
 * polls and the weather layer is briefly missing some warnings. It is bounded by TTL only,
 * which is why the map route wraps its own store with an entry ceiling and eviction.
 */
export function createMemoryCache(): SourceCache & { readonly size: () => number } {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  return {
    get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(null);
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.value);
    },
    set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      store.set(key, {
        value,
        expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
      });
      return Promise.resolve();
    },
    size: () => store.size,
  };
}
