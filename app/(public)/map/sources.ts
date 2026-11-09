import type { Connector } from "@/db/schema";
import { findAdapter as findSourceAdapter, pollSource } from "@/lib/sources";
import type { GovernanceDeps } from "@/lib/sources";
import type {
  Attribution,
  CachedSourceResult,
  PositionalPrecision,
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFeature,
  SourceQuery,
} from "@/lib/sources/types";
import { normaliseSourceQuery, sourceQueryKey } from "@/components/map/query";
import { dropPayload, readPayload, writePayload } from "@/lib/live/feature-cache";
import { devStressSource } from "./dev-stress-source";

/**
 * Server-only data loading for the map (used by `page.tsx` and `data/[slug]/route.ts`).
 * Turns a registry `sourceSlug` into a `CachedSourceResult`, adding the shared cache and
 * staleness on top of the `lib/sources/` adapters.
 *
 * Cache key is `slug:normalisedQuery`, never per viewer: it keeps us within upstream fair use,
 * hides individual users from upstreams, and can't encode who asked. Global feeds share
 * `slug:unscoped`.
 *
 * The cache is in-process memory only: a restart empties it and the next reader pays a cold
 * poll. Payloads are never written to the database.
 */

/* ------------------------------------------------------------------ *
 * The adapter lookup
 * ------------------------------------------------------------------ */

/** The adapter for a slug, or null (the layer then renders `notConfigured`). */
export function resolveAdapter(slug: string): SourceAdapter<SourceFeature> | null {
  const real = findSourceAdapter(slug);
  if (real) return real;
  /*
   * Dev-only stress source. Also gated by `devOnly` in `components/map/registry/index.ts`;
   * `NODE_ENV` is inlined at build time so both branches are stripped from production.
   */
  if (process.env.NODE_ENV !== "production" && slug === devStressSource.slug) {
    return devStressSource;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Governance for a source that has no upstream
 * ------------------------------------------------------------------ */

/**
 * In-memory connector row for the dev-only stress source. `pollSource` refuses sources
 * without a row, and seeding one would put a fake upstream in the real registry. This keeps
 * the stress layer on the same `pollSource` path as everything else.
 */
function stressConnectorRow(): Connector {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-00000000de00",
    slug: devStressSource.slug,
    name: devStressSource.name,
    kind: devStressSource.kind,
    operatorName: "none — generated in this process",
    homepageUrl: devStressSource.homepage,
    termsUrl: devStressSource.homepage,
    attribution: devStressSource.attribution.text,
    attributionRequired: false,
    legalBasis:
      "No upstream exists. The adapter generates synthetic points locally, so there are no terms to satisfy and no operator to credit. Development builds only.",
    baseUrl: "about:blank",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 1000,
    globalCeiling: 1000,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: devStressSource.ttlSeconds,
    staleWhileRevalidateSeconds: devStressSource.staleWhileRevalidateSeconds,
    pollMode: "onDemand",
    enabled: true,
    status: "published",
    lastCheckedAt: now,
    notes: "Synthetic renderer stress harness. Never present in a production build.",
    updatedById: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Governance overrides: none, except for the dev-only stress source (stripped in production). */
function governanceFor(adapter: SourceAdapter<SourceFeature>): Partial<GovernanceDeps> {
  if (process.env.NODE_ENV === "production" || adapter.slug !== devStressSource.slug) return {};
  return {
    getConnector: async () => stressConnectorRow(),
    /* No outbound request, so no global ceiling to spend. */
    consumeGlobal: async () => ({ ok: true }),
    /* No audit row: the FK to `connectors` would fail, and no outbound call is made. */
    audit: async () => {},
  };
}

/* ------------------------------------------------------------------ *
 * The shared cache
 * ------------------------------------------------------------------ */

/*
 * The payload cache is in `lib/live/feature-cache.ts` so `addWorkspaceItem` can also read
 * it when saving a feature.
 */

/**
 * Side cache for adapters' own lookups (e.g. NWS zone centroids, Radio Browser mirror),
 * separate from the payload cache.
 */
const globalForSideCache = globalThis as typeof globalThis & {
  __cairnMapSideCache?: Map<string, { value: string; expiresAt: number }>;
};

const sideCache = (globalForSideCache.__cairnMapSideCache ??= new Map());

/**
 * Cache key: source plus normalised query. Uses the same normalisation as the request
 * (`components/map/query.ts`), which the client also uses to decide if a pan needs a fetch.
 */
function cacheKeyFor(adapter: SourceAdapter<SourceFeature>, query: SourceQuery): string {
  return `${adapter.slug}:${sourceQueryKey(query)}`;
}

/**
 * Get/set only, so adapters can't enumerate or flush others' entries. Not durable: adapters
 * must treat a miss as a cold start.
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
      /* Default TTL of one day so entries can't accumulate forever. */
      expiresAt: Date.now() + (ttlSeconds ?? 86_400) * 1000,
    });
  },
};

const REQUEST_TIMEOUT_MS = 9000;

/**
 * Result of one governed poll. `ttlSeconds` and `attribution` come from the registry row,
 * which is authoritative over adapter constants and can be changed without a deploy.
 */
export interface MapSourceLoad extends CachedSourceResult<SourceFeature> {
  readonly ttlSeconds: number;
  readonly attribution: Attribution;
}

/**
 * Fetch a source through the shared cache:
 *
 *   fresh        inside the TTL, or a successful refresh
 *   stale        past the TTL, refresh failed, still inside the horizon
 *   unavailable  past the horizon, or no data ever obtained
 *
 * `stale` is only known here, which is why `SourceResult` doesn't carry it.
 *
 * Always goes through `pollSource` (registry lookup, kill-switch, global ceiling, audit),
 * never `adapter.fetch`, so the kill-switch applies to the map too.
 */
export async function loadSource(
  adapter: SourceAdapter<SourceFeature>,
  query: SourceQuery,
  /**
   * Layer-level precision fallback, applied before caching so snapshots and exports (which
   * read the feature directly) keep the caveat. Needed until every adapter (e.g. `nws-alerts`)
   * sets `SourceFeature.precision` itself.
   */
  precisionFallback?: (feature: SourceFeature) => PositionalPrecision | null,
): Promise<MapSourceLoad> {
  /** Never overwrites an adapter's value; `null` from an adapter means "exact". */
  const withPrecision = (features: readonly SourceFeature[]): readonly SourceFeature[] => {
    if (!precisionFallback) return features;
    return features.map((feature) =>
      feature.precision === undefined
        ? { ...feature, precision: precisionFallback(feature) }
        : feature,
    );
  };

  // Normalise once and use it for both the cache key and the request.
  const normalised = normaliseSourceQuery(query);
  const key = cacheKeyFor(adapter, normalised);
  const cached = readPayload(key);
  const now = Date.now();

  /*
   * A cache hit makes no outbound call, so no re-authorisation. A switched-off source can stay
   * visible for at most one TTL before the next poll sees the switch and purges it.
   */
  if (cached && (now - cached.observedAt.getTime()) / 1000 < cached.ttlSeconds) {
    return {
      result: { ok: true, features: cached.features, observedAt: cached.observedAt },
      stale: false,
      cachedAt: cached.cachedAt,
      ttlSeconds: cached.ttlSeconds,
      attribution: cached.attribution,
    };
  }

  const ctx: SourceContext = {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache,
    /*
     * A getter rather than `process.env` so adapters can't enumerate secrets. A missing key
     * makes the adapter return `notConfigured`; the build doesn't need runtime secrets.
     */
    env: (name: string) => process.env[name],
  };

  const { result, ttlSeconds, attribution } = await pollSource(
    adapter,
    normalised,
    ctx,
    governanceFor(adapter),
  );

  if (result.ok) {
    // Cached with the payload because `addWorkspaceItem` copies them into snapshots.
    const features = withPrecision(result.features);
    const entry = {
      sourceSlug: adapter.slug,
      sourceName: adapter.name,
      sourceKind: adapter.kind,
      features,
      observedAt: result.observedAt,
      cachedAt: new Date(),
      ttlSeconds,
      attribution,
    };
    writePayload(key, entry);
    return {
      /* Same features as the cache entry. */
      result: { ok: true, features, observedAt: result.observedAt },
      stale: false,
      cachedAt: entry.cachedAt,
      ttlSeconds,
      attribution,
    };
  }

  /*
   * Upstream failures (`rateLimited`, `timeout`, `upstreamError`) may serve stale data.
   * Our own refusals (kill-switch, missing key, spent quota) drop the entry immediately.
   */
  const isOurDecision =
    result.failure.kind === "disabled" ||
    result.failure.kind === "notConfigured" ||
    result.failure.kind === "quotaExhausted";

  if (cached && !isOurDecision) {
    const ageSeconds = (now - cached.observedAt.getTime()) / 1000;
    // Per-adapter horizon (e.g. minutes for aircraft, a day for a camera index).
    const horizon = cached.ttlSeconds + adapter.staleWhileRevalidateSeconds;
    if (ageSeconds <= horizon) {
      return {
        result: { ok: true, features: cached.features, observedAt: cached.observedAt },
        stale: true,
        cachedAt: cached.cachedAt,
        ttlSeconds: cached.ttlSeconds,
        attribution: cached.attribution,
      };
    }
  }

  // Past the horizon or refused by us: drop the entry.
  const lastGoodAt = cached?.observedAt ?? null;
  dropPayload(key);
  return {
    result: { ok: false, failure: result.failure, lastGoodAt },
    stale: false,
    cachedAt: cached?.cachedAt ?? new Date(),
    ttlSeconds,
    attribution,
  };
}
