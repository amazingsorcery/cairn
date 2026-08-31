import { findAdapter as findSourceAdapter } from "@/lib/sources";
import type {
  CachedSourceResult,
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFeature,
  SourceQuery,
} from "@/lib/sources/types";
import { devStressSource } from "./dev-stress-source";

/**
 * WHERE THE MAP GETS ITS DATA. Server-only — imported by `page.tsx` and by
 * `data/[slug]/route.ts`, and by nothing in `components/map/`.
 *
 * Its whole job is to turn a registry entry's `sourceSlug` into a `CachedSourceResult`. The
 * adapters themselves belong to the integrations engineer in `lib/sources/`; this file adds
 * the two things the contract deliberately leaves to the caller — the shared cache and the
 * staleness that only the cache can know.
 *
 * ## The cache is one entry per source, never per viewer
 *
 * ADR 0014 §4. One shared payload serves every reader, which does three things at once: it
 * holds us inside each upstream's fair-use ceiling, it means the upstream sees our server
 * rather than a pattern of individual users, and it guarantees the cache key cannot encode
 * who asked. A per-user key on a live surface would rebuild the interest graph ADR 0013
 * removed from the audit log.
 *
 * §6 of the same ADR: the payload rests only here, for a bounded time, and never in a table.
 * A module-level `Map` satisfies all of that. What it does not do is survive more than one
 * process — ADR 0019 puts Redis and a poller worker in the stack for exactly that, and when
 * they exist this file reads their key instead of holding its own.
 */

/* ------------------------------------------------------------------ *
 * The adapter lookup
 * ------------------------------------------------------------------ */

/**
 * The adapter for a source slug, or null.
 *
 * Null rather than throwing. A registry entry whose adapter has not landed yet renders
 * `notConfigured` on that layer alone with a sentence saying so — which is a designed state,
 * and is what lets a layer be designed before its source exists.
 */
export function resolveAdapter(slug: string): SourceAdapter<SourceFeature> | null {
  const real = findSourceAdapter(slug);
  if (real) return real;
  /*
   * The synthetic renderer stress source. Two independent gates keep it out of production —
   * this one and the `devOnly` filter in `components/map/registry/index.ts` — because
   * `process.env.NODE_ENV` is a build-time constant, so both branches are dropped from the
   * production bundle rather than merely hidden. Synthetic data on a shipped path would be
   * fabricated content on a product whose entire value is credibility (product-brief §6).
   */
  if (process.env.NODE_ENV !== "production" && slug === devStressSource.slug) {
    return devStressSource;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The shared cache
 * ------------------------------------------------------------------ */

interface CacheEntry {
  readonly features: readonly SourceFeature[];
  readonly observedAt: Date;
  readonly cachedAt: Date;
}

/**
 * Held on `globalThis` rather than in a module binding.
 *
 * Next's dev server re-evaluates a module on every edit, so a plain `const cache = new Map()`
 * empties on every save — which turns a 60-second TTL into "every keystroke calls USGS". In
 * production it makes no difference; in development it is the difference between respecting
 * an upstream's cadence and hammering it while you work.
 */
const globalForCache = globalThis as typeof globalThis & {
  __cairnMapSourceCache?: Map<string, CacheEntry>;
  __cairnMapSideCache?: Map<string, { value: string; expiresAt: number }>;
};

const payloadCache = (globalForCache.__cairnMapSourceCache ??= new Map());
const sideCache = (globalForCache.__cairnMapSideCache ??= new Map());

/**
 * The `SourceCache` the contract hands to every adapter.
 *
 * Several adapters need a long-lived side cache that is not their payload — NWS resolves UGC
 * zone codes to centroids, Radio Browser discovers a mirror — and without a handle here each
 * would invent its own in-process map that empties on every deploy. This is Redis's seat,
 * occupied by a `Map` until the worker container exists. It is deliberately the narrow
 * `get`/`set` slice: an adapter that could enumerate or flush the cache would be able to
 * reach data that is not its own.
 */
const cache: SourceCache = {
  async get(key: string): Promise<string | null> {
    const entry = sideCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      sideCache.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    sideCache.set(key, {
      value,
      /* No TTL means "for this process", not "forever": an unbounded cache on a small VPS
         is a slow memory leak with a friendly name. A day is the ceiling. */
      expiresAt: Date.now() + (ttlSeconds ?? 86_400) * 1000,
    });
  },
};

/**
 * How long past its TTL a payload may still be shown, marked stale, while a refresh is
 * attempted. Past `ttl + this` the layer shows nothing rather than something old
 * (ADR 0014 §3): there is a point past which "earthquakes from forty minutes ago" is not
 * degraded service but a different and misleading product.
 *
 * ADR 0014 §2 makes this a per-connector configured window and `SourceAdapter` has no field
 * for it — recorded as a proposed addition in `docs/frontend/HANDOFF-map.md` §8. A multiplier
 * is the honest placeholder: it is proportional to each source's own cadence rather than one
 * number pretending to fit a 30-second aircraft feed and a one-hour camera index.
 */
const STALE_WHILE_REVALIDATE_MULTIPLIER = 10;

const REQUEST_TIMEOUT_MS = 9000;

/**
 * Fetch a source through the shared cache. Three outcomes, matching ADR 0014 §2 exactly:
 *
 *   fresh        inside the TTL, or a successful refresh
 *   stale        past the TTL, refresh failed, still inside the horizon: same data, marked
 *   unavailable  past the horizon, or no data was ever obtained
 *
 * `stale` is set HERE and nowhere else, because here is the only place that knows. That is
 * why `SourceResult` no longer carries the field: an adapter has just called upstream and
 * could only ever have written `false`, which is six adapters lying the same way.
 */
export async function loadSource(
  adapter: SourceAdapter<SourceFeature>,
  query: SourceQuery,
): Promise<CachedSourceResult<SourceFeature>> {
  const cached = payloadCache.get(adapter.slug);
  const now = Date.now();

  if (cached && (now - cached.observedAt.getTime()) / 1000 < adapter.ttlSeconds) {
    return {
      result: { ok: true, features: cached.features, observedAt: cached.observedAt },
      stale: false,
      cachedAt: cached.cachedAt,
    };
  }

  const ctx: SourceContext = {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache,
    /*
     * `env` is a function rather than the whole `process.env` so an adapter reads the one key
     * it declared and cannot browse the deployment's secrets. A missing key comes back
     * `undefined` and the adapter returns `notConfigured` upward rather than throwing —
     * ADR 0018: the build must not require runtime secrets.
     */
    env: (name: string) => process.env[name],
  };

  const result = await adapter.fetch(query, ctx);

  if (result.ok) {
    payloadCache.set(adapter.slug, {
      features: result.features,
      observedAt: result.observedAt,
      cachedAt: new Date(),
    });
    return { result, stale: false, cachedAt: new Date() };
  }

  if (cached) {
    const ageSeconds = (now - cached.observedAt.getTime()) / 1000;
    const horizon = adapter.ttlSeconds * (1 + STALE_WHILE_REVALIDATE_MULTIPLIER);
    if (ageSeconds <= horizon) {
      return {
        result: { ok: true, features: cached.features, observedAt: cached.observedAt },
        stale: true,
        cachedAt: cached.cachedAt,
      };
    }
    /*
     * Past the horizon the entry is dropped rather than kept with an ever-growing age label.
     * A cache is not a place to keep data we have decided not to show.
     */
    payloadCache.delete(adapter.slug);
    return {
      result: { ok: false, failure: result.failure, lastGoodAt: cached.observedAt },
      stale: false,
      cachedAt: cached.cachedAt,
    };
  }

  return { result, stale: false, cachedAt: new Date() };
}
