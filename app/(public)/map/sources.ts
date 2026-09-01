import type { Connector } from "@/db/schema";
import { findAdapter as findSourceAdapter, pollSource } from "@/lib/sources";
import type { GovernanceDeps } from "@/lib/sources";
import type {
  Attribution,
  CachedSourceResult,
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFeature,
  SourceQuery,
} from "@/lib/sources/types";
import { normaliseSourceQuery, sourceQueryKey } from "@/components/map/query";
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
 * ## The cache is one entry per source AND QUESTION, never per viewer
 *
 * ADR 0014 §4. One shared payload serves every reader, which does three things at once: it
 * holds us inside each upstream's fair-use ceiling, it means the upstream sees our server
 * rather than a pattern of individual users, and it guarantees the cache key cannot encode
 * who asked. A per-user key on a live surface would rebuild the interest graph ADR 0013
 * removed from the audit log.
 *
 * **Shared per question, not per source.** The key was the slug alone, which is right for the
 * five global feeds and was wrong the moment one layer became viewport-scoped: a reader who
 * opened `/map` inside one TTL of somebody zooming into Tokyo was handed Tokyo's aircraft as
 * the answer for Europe, marked `fresh`, with a real observation instant under it (QA finding
 * QV-04). The key is now `slug:normalisedQuery` — the same shape `lib/connectors/runtime.ts`
 * uses — and the normalised query is what the adapter is handed, so the entry cannot be the
 * answer to a question nobody asked. A global feed passes `{}` and every reader still shares
 * `slug:unscoped`, which is what ADR 0014 §4 is actually about.
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
 * Governance for a source that has no upstream
 * ------------------------------------------------------------------ */

/**
 * The registry row the **development-only** stress source is authorised against.
 *
 * ## Why this exists at all
 *
 * `pollSource` resolves a `connectors` row and refuses anything without one — correctly, and
 * that refusal is the kill-switch working. The synthetic 10,000-point layer has no row, so it
 * rendered as `disabled` and the renderer measurement the brief requires ("10k+ points
 * without dropping frames") could not be taken at all. QA hit exactly that.
 *
 * ## Why it is a synthetic row rather than a seeded one
 *
 * Seeding a row would put a connector for a source that does not exist into the operator's
 * registry — the one table whose value is that every row is a real upstream with a recorded
 * legal basis. Instead the row is supplied here, in memory, for one slug, under a
 * `NODE_ENV` gate the bundler evaluates at build time, so it cannot exist in production.
 *
 * The point is that the stress layer still goes through `pollSource` like every other source:
 * the rule is one governed path, not one governed path plus an exception. Nothing outbound
 * happens either way — the adapter generates its points in this process — which is also why
 * the ceiling is nominal and the audit is a no-op below.
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

/**
 * Governance overrides for one adapter: none, except for the dev-only stress source.
 *
 * Both gates are build-time constants, so this whole branch — and the row above it — is
 * dropped from a production bundle rather than merely unreachable, which is the same
 * construction `resolveAdapter` and `MAP_LAYERS` use for the same layer.
 */
function governanceFor(adapter: SourceAdapter<SourceFeature>): Partial<GovernanceDeps> {
  if (process.env.NODE_ENV === "production" || adapter.slug !== devStressSource.slug) return {};
  return {
    getConnector: async () => stressConnectorRow(),
    /* No request leaves this process, so there is no upstream fair-use share to spend. */
    consumeGlobal: async () => ({ ok: true }),
    /*
     * No audit row: `connector_requests.connector_id` is a foreign key and this row is not in
     * the table. Writing one would mean seeding the fiction into the database, which is the
     * thing this construction exists to avoid — and an audit log records outbound calls, of
     * which this makes none.
     */
    audit: async () => {},
  };
}

/* ------------------------------------------------------------------ *
 * The shared cache
 * ------------------------------------------------------------------ */

interface CacheEntry {
  readonly features: readonly SourceFeature[];
  readonly observedAt: Date;
  readonly cachedAt: Date;
  /**
   * The TTL and credit the **governed poll** returned, cached with the payload.
   *
   * Both are the registry row's, not the adapter's constant, and both must survive a cache
   * hit — otherwise a hit would measure freshness against a number the operator has changed,
   * and would render a layer without the credit its licence requires.
   */
  readonly ttlSeconds: number;
  readonly attribution: Attribution;
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
 * Hard ceiling on distinct entries, so a crafted stream of viewport parameters cannot grow
 * this Map without bound on a small VPS. Eviction is oldest-first, and the whole-degree grid
 * in `normaliseSourceQuery` is the first line of defence: it bounds the key space long before
 * this does. Same construction and same number as `lib/connectors/runtime.ts`.
 *
 * It was not needed while the key was one entry per source. It is needed now.
 */
const MAX_CACHE_ENTRIES = 256;

/**
 * The cache key: the source, plus the question, normalised.
 *
 * `sourceQueryKey` and the query handed to `pollSource` come from the same normalisation
 * (`components/map/query.ts`), so the key cannot describe a different area than the one the
 * upstream was asked about. The client computes the same key to decide whether a pan needs a
 * request at all — one function, three callers, no second grid to drift.
 */
function cacheKeyFor(adapter: SourceAdapter<SourceFeature>, query: SourceQuery): string {
  return `${adapter.slug}:${sourceQueryKey(query)}`;
}

function writeCache(key: string, entry: CacheEntry): void {
  if (payloadCache.size >= MAX_CACHE_ENTRIES && !payloadCache.has(key)) {
    const oldest = payloadCache.keys().next();
    if (!oldest.done) payloadCache.delete(oldest.value);
  }
  payloadCache.set(key, entry);
}

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

const REQUEST_TIMEOUT_MS = 9000;

/**
 * What the map needs back from one governed poll.
 *
 * `ttlSeconds` and `attribution` are on here rather than read off the adapter because the
 * **registry row is authoritative for both** (ADR 0024). The row's `cache_ttl_seconds` is
 * what an operator can change under load without a deploy — the same argument that made
 * `enabled` a column — and for adsb.lol the row says 60s where the adapter constant says 30s.
 * Reading `adapter.ttlSeconds` here would poll twice as fast as the operator asked.
 */
export interface MapSourceLoad extends CachedSourceResult<SourceFeature> {
  readonly ttlSeconds: number;
  readonly attribution: Attribution;
}

/**
 * Fetch a source through the shared cache. Three outcomes, matching ADR 0014 §2 exactly:
 *
 *   fresh        inside the TTL, or a successful refresh
 *   stale        past the TTL, refresh failed, still inside the horizon: same data, marked
 *   unavailable  past the horizon, or no data was ever obtained
 *
 * `stale` is set HERE and nowhere else, because here is the only place that knows. That is
 * why `SourceResult` does not carry the field: an adapter has just called upstream and could
 * only ever have written `false`, which is six adapters lying the same way.
 *
 * ## Every upstream call goes through `pollSource`, never `adapter.fetch`
 *
 * `pollSource` does the registry lookup, the kill-switch, the global ceiling and the audit
 * row, in that order, and a disabled source returns its typed `disabled` failure **before any
 * request**. Calling `adapter.fetch` here would make the map a second, ungoverned route to
 * the same upstream — so an operator hitting the kill-switch would silence `/live/flights`
 * while `/map` kept calling. A kill-switch that does not kill is worse than none, because the
 * operator believes the traffic stopped and stops looking.
 */
export async function loadSource(
  adapter: SourceAdapter<SourceFeature>,
  query: SourceQuery,
): Promise<MapSourceLoad> {
  /*
   * NORMALISED ONCE, HERE, AND USED FOR BOTH THE KEY AND THE CALL. Deriving the key from one
   * value and the request from another is QV-04 in miniature, so there is deliberately no
   * second expression of the grid below this line.
   */
  const normalised = normaliseSourceQuery(query);
  const key = cacheKeyFor(adapter, normalised);
  const cached = payloadCache.get(key);
  const now = Date.now();

  /*
   * A cache hit makes no outbound call, so it does not need re-authorising: the kill-switch
   * governs traffic, and there is none. The TTL it is measured against is the one the last
   * governed poll returned — the registry row's — so an operator who lowers it shortens this
   * window too. Worst case a switched-off source stays on screen for one TTL, and then the
   * poll below observes the switch and the entry is purged rather than allowed to go stale.
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
     * `env` is a function rather than the whole `process.env` so an adapter reads the one key
     * it declared and cannot browse the deployment's secrets. A missing key comes back
     * `undefined` and the adapter returns `notConfigured` upward rather than throwing —
     * ADR 0018: the build must not require runtime secrets.
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
    const entry: CacheEntry = {
      features: result.features,
      observedAt: result.observedAt,
      cachedAt: new Date(),
      ttlSeconds,
      attribution,
    };
    writeCache(key, entry);
    return { result, stale: false, cachedAt: entry.cachedAt, ttlSeconds, attribution };
  }

  /*
   * A REFUSAL IS NOT AN OUTAGE, AND STALE-WHILE-REVALIDATE MUST NOT SURVIVE ONE.
   *
   * `rateLimited`, `timeout` and `upstreamError` mean the upstream is having a moment, and
   * showing the last good payload with a visible "stale" marker is the right service. A
   * kill-switch, a missing key or a spent budget are OUR decisions, and continuing to display
   * a source an operator has just switched off would rebuild — one layer down, in the cache —
   * exactly the defect that made this function call `pollSource` in the first place. So the
   * entry is dropped and the layer goes to its unavailable state immediately.
   */
  const isOurDecision =
    result.failure.kind === "disabled" ||
    result.failure.kind === "notConfigured" ||
    result.failure.kind === "quotaExhausted";

  if (cached && !isOurDecision) {
    const ageSeconds = (now - cached.observedAt.getTime()) / 1000;
    /*
     * The horizon is the adapter's own declared window, not a multiplier. Aircraft declare
     * three minutes because a stale position is worse than none; a camera index a day. One
     * number cannot fit both, which is why this is on the contract now (ADR 0014 §3).
     */
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

  /*
   * Past the horizon, or refused by us, the entry is dropped rather than kept with an
   * ever-growing age label. A cache is not a place to keep data we have decided not to show.
   */
  const lastGoodAt = cached?.observedAt ?? null;
  payloadCache.delete(key);
  return {
    result: { ok: false, failure: result.failure, lastGoodAt },
    stale: false,
    cachedAt: cached?.cachedAt ?? new Date(),
    ttlSeconds,
    attribution,
  };
}
