import type { z } from "zod";

import type { SourceCache } from "./types";

/**
 * Helpers over the `SourceCache` handed to an adapter in `SourceContext`.
 *
 * The cache is just `get`/`set` on strings; these add schema-validated JSON and namespaced
 * keys. A cache failure never fails a poll: bad or unreachable entries read as `null`.
 */

/** Namespaced so two adapters cannot collide on a key like `zones`. */
export function cacheKey(slug: string, name: string): string {
  return `source:${slug}:${name}`;
}

/** Read and validate a cached JSON value (entries from an older build may have another shape). */
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
    // Swallowed: we already have the data.
  }
}

/**
 * An in-process `SourceCache`, for tests and CLI healthchecks. Production also uses a
 * per-process map (`app/(public)/map/sources.ts`), so nothing survives a restart: after a
 * deploy, NWS zone centroids are re-resolved over several polls. Bounded by TTL only.
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
