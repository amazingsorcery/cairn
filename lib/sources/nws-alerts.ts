import { z } from "zod";

import { applyLimit, healthcheckByFetch, normaliseVia, parseWith, withinBbox } from "./adapter";
import { cacheKey, getJson, setJson } from "./cache";
import { geometrySchema, representativePoint } from "./geometry";
import { decodeJson, fetchUpstream, lastGoodAt, recordGood } from "./http";
import type {
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * NOAA / National Weather Service active alerts — watches, warnings and advisories.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-08-31. Full record in `docs/sources/nws-alerts.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      US Government public domain. weather.gov/documentation/services-web-api
 *              (read 2026-08-31): "All of the information presented via the API is intended
 *              to be open data, free to use for any purpose."
 * Key          None.
 * User-Agent   REQUIRED, and this is the one upstream here that enforces it. The docs ask for
 *              an identifying string with contact details — see `sourceUserAgent()` in
 *              `http.ts`.
 * Rate limit   Not published: "The rate limit is not public information, but allows a
 *              generous amount for typical use." Their words. With no number to respect, the
 *              TTL is set conservatively (60s) and one shared poll serves every reader, so
 *              our total traffic is one request per minute regardless of audience size.
 *              Note their warning that "proxies are more likely to reach the limit" — we are
 *              a proxy by their definition, which is a reason to poll slowly, not quickly.
 * Access ctrl  None circumvented. Documented public endpoints, no auth, no scraping.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE PROBLEM THIS ADAPTER EXISTS TO SOLVE, measured 2026-08-31:
 *
 *   Of 385 active alerts, **five** carried inline GeoJSON geometry. 1.3%.
 *
 * The other 380 identify their area only by UGC zone code (`AZC019`, `ANZ338`). An adapter
 * that emitted just the polygon-bearing alerts would render a weather layer showing 1% of
 * American weather warnings while looking complete — the specific kind of confidently-wrong
 * output that product-brief §6 says destroys the product's credibility. So zones are
 * resolved to a point, and the constraint is doing it without hammering a service whose rate
 * limit is unpublished:
 *
 *   - Zone geometry comes only from the single-zone endpoint, one call per zone (~19 KB).
 *   - Zone boundaries are effectively static — the payloads carry `expirationDate` of
 *     2200-01-01 — so a resolved zone is cached in `SourceContext.cache` and not re-fetched.
 *   - At most `MAX_ZONE_LOOKUPS_PER_POLL` unseen zones are resolved per poll. Coverage fills
 *     in over the first several polls instead of arriving as a 700-request burst; steady
 *     state costs zero extra calls. QA finding Q-02 was a burst, and this is what not
 *     repeating it looks like.
 *   - A zone that answers with no usable geometry is cached as a permanent miss, so a retired
 *     code is not retried forever. A *transport* failure is deliberately NOT cached, or one
 *     bad network moment would blind us to a zone until the entry expired.
 *
 * The cache is the durable one passed in through `SourceContext`, not an in-process map. That
 * matters more than it looks: an in-process map empties on every deploy, and the layer then
 * spends half an hour progressively incomplete — silent incompleteness arriving by a second
 * route, which is the exact failure this adapter was written to prevent.
 */

const ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual";
const ZONE_BASE = "https://api.weather.gov/zones";

/** Bounded per-poll zone warm-up. See the burst note above. */
const MAX_ZONE_LOOKUPS_PER_POLL = 12;

/** A zone lookup is small and static; it does not deserve the full request budget. */
const ZONE_TIMEOUT_MS = 6_000;

export const NWS_ALERTS_SLUG = "nws-alerts";

/* ------------------------------------------------------------------ *
 * Upstream schemas
 * ------------------------------------------------------------------ */

const alertPropertiesSchema = z
  .object({
    id: z.string().nullish(),
    areaDesc: z.string().nullish(),
    geocode: z
      .object({
        UGC: z.array(z.string()).nullish(),
        SAME: z.array(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
    sent: z.string().nullish(),
    effective: z.string().nullish(),
    onset: z.string().nullish(),
    expires: z.string().nullish(),
    ends: z.string().nullish(),
    status: z.string().nullish(),
    messageType: z.string().nullish(),
    category: z.string().nullish(),
    severity: z.string().nullish(),
    certainty: z.string().nullish(),
    urgency: z.string().nullish(),
    event: z.string().nullish(),
    senderName: z.string().nullish(),
    headline: z.string().nullish(),
    description: z.string().nullish(),
    instruction: z.string().nullish(),
    response: z.string().nullish(),
  })
  .passthrough();

const alertFeatureSchema = z
  .object({
    id: z.string(),
    geometry: geometrySchema.nullable(),
    properties: alertPropertiesSchema,
  })
  .passthrough();

/**
 * `features` and `updated` are required. Defaulting either would let an unrelated document
 * parse as "no weather warnings anywhere", which on this layer is the worst possible lie.
 */
export const nwsAlertsResponseSchema = z
  .object({
    type: z.string(),
    features: z.array(alertFeatureSchema),
    /** ISO 8601. The upstream's own clock for this collection. */
    updated: z.string(),
  })
  .passthrough();

/** One zone, from `/zones/{type}/{id}`. Only the fields the centroid needs. */
export const nwsZoneResponseSchema = z
  .object({
    geometry: geometrySchema.nullable(),
    properties: z
      .object({
        id: z.string(),
        name: z.string().nullish(),
        state: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

/* ------------------------------------------------------------------ *
 * The zone cache
 * ------------------------------------------------------------------ */

const zonePointSchema = z.object({
  longitude: z.number(),
  latitude: z.number(),
  name: z.string().nullable(),
});
type ZonePoint = z.infer<typeof zonePointSchema>;

/**
 * The durable map of UGC code to point, stored as ONE cache entry.
 *
 * One entry rather than one key per zone, deliberately: ~700 zones at roughly 60 bytes each is
 * about 45 KB, which is one GET and an occasional SET per poll instead of seven hundred
 * sequential round trips. `null` is a cached permanent miss.
 */
const zoneMapSchema = z.record(z.string(), zonePointSchema.nullable());
type ZoneMap = Record<string, ZonePoint | null>;

const ZONE_CACHE_KEY = cacheKey(NWS_ALERTS_SLUG, "zone-points");

/**
 * 30 days. Zone boundaries are effectively static, but NWS does revise them a few times a
 * year, and an entry that never expires is an entry nobody ever notices is wrong.
 */
const ZONE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The per-call view of the zone map.
 *
 * `normalise` is synchronous by contract, so it cannot await a cache read. `fetch` loads the
 * durable map once per poll and installs it here before mapping. This is a read-through view
 * of `SourceContext.cache`, **not** a second source of truth — the distinction that matters,
 * because the previous version's in-process map *was* the source of truth and emptied on
 * every deploy.
 */
const globalForZones = globalThis as typeof globalThis & { __cairnNwsZones__?: ZoneMap };
function currentZoneMap(): ZoneMap {
  return (globalForZones.__cairnNwsZones__ ??= {});
}

/**
 * UGC codes are two letters, then `C` (county) or `Z` (forecast/marine zone), then three
 * digits. The regex is not tidiness: this string is interpolated into a URL we then fetch
 * server-side, which is the SSRF shape ADR 0019 calls v2's top risk. Anything that does not
 * match this exact form never reaches `fetch`.
 */
const UGC_PATTERN = /^[A-Z]{2}[CZ]\d{3}$/;

function zoneUrl(ugc: string): string | null {
  if (!UGC_PATTERN.test(ugc)) return null;
  const type = ugc[2] === "C" ? "county" : "forecast";
  return `${ZONE_BASE}/${type}/${ugc}`;
}

/** Test seam and operator tool: seed or inspect resolved zones without a network call. */
export function primeZoneCache(ugc: string, point: ZonePoint | null): void {
  currentZoneMap()[ugc] = point;
}

export function clearZoneCache(): void {
  globalForZones.__cairnNwsZones__ = {};
}

export function zoneCacheSize(): number {
  return Object.keys(currentZoneMap()).length;
}

/** Resolve one zone to a point. Returns null on any failure; never throws. */
async function fetchZone(ugc: string, ctx: SourceContext): Promise<ZonePoint | null> {
  const url = zoneUrl(ugc);
  if (!url) return null;

  const outcome = await fetchUpstream({
    slug: NWS_ALERTS_SLUG,
    url,
    signal: ctx.signal,
    timeoutMs: ZONE_TIMEOUT_MS,
    headers: { accept: "application/geo+json" },
  });
  if (!outcome.ok) return null;

  const decoded = decodeJson(outcome.text);
  if (!decoded.ok) return null;
  const parsed = nwsZoneResponseSchema.safeParse(decoded.body);
  if (!parsed.success) return null;

  const point = representativePoint(parsed.data.geometry);
  if (!point) return null;
  return { ...point, name: parsed.data.properties.name ?? null };
}

/**
 * Load the durable zone map into the per-call view.
 *
 * A cache miss or a malformed entry is a cold start, not an error: the warm-up refills it a
 * dozen zones at a time.
 */
async function loadZoneMap(cache: SourceCache): Promise<void> {
  const stored = await getJson(cache, ZONE_CACHE_KEY, zoneMapSchema);
  if (!stored) return;
  const current = currentZoneMap();
  for (const [ugc, point] of Object.entries(stored)) {
    // A zone resolved during THIS process wins over the stored copy: it is at least as fresh.
    if (!(ugc in current)) current[ugc] = point;
  }
}

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface WeatherAlertFeature extends SourceFeature {
  readonly kind: "weather";
  readonly properties: {
    /** e.g. "Severe Thunderstorm Warning". The headline classification. */
    readonly event: string | null;
    /** Extreme | Severe | Moderate | Minor | Unknown, from the CAP standard. */
    readonly severity: string | null;
    /** Immediate | Expected | Future | Past | Unknown. */
    readonly urgency: string | null;
    /** Observed | Likely | Possible | Unlikely | Unknown. */
    readonly certainty: string | null;
    readonly headline: string | null;
    /** Plain-language area, e.g. "Pima, AZ". Often more useful than the point. */
    readonly areaDescription: string | null;
    readonly effectiveAt: string | null;
    readonly expiresAt: string | null;
    readonly issuedBy: string | null;
    /** What the public is told to do: Shelter, Evacuate, Avoid, Monitor, None. */
    readonly recommendedResponse: string | null;
    /**
     * HOW the point was derived, so the UI can say so. `polygon` is the alert's own warning
     * polygon; `zone` is the centroid of the administrative zone it names, which can be tens
     * of kilometres from where the weather actually is.
     */
    readonly locationBasis: "polygon" | "zone";
    /** The UGC zone the point came from, when the basis is `zone`. */
    readonly zoneCode: string | null;
    /** True when the alert names more zones than the one we placed it on. */
    readonly coversMultipleZones: boolean;
  };
}

type AlertsPayload = z.infer<typeof nwsAlertsResponseSchema>;

/**
 * Map validated alerts to features, using whatever the per-call zone view holds.
 *
 * Synchronous by contract, so it performs no I/O — which is also what makes it testable
 * against the captured payload: prime the zone map, map the fixture, assert.
 */
function mapNwsAlerts(data: AlertsPayload, query: SourceQuery): readonly WeatherAlertFeature[] {
  const zoneMap = currentZoneMap();
  const features: WeatherAlertFeature[] = [];

  for (const item of data.features) {
    const props = item.properties;
    const zones = (props.geocode?.UGC ?? []).filter((code) => UGC_PATTERN.test(code));

    let position = representativePoint(item.geometry);
    let basis: "polygon" | "zone" = "polygon";
    let zoneCode: string | null = null;

    if (!position) {
      // First zone we have already resolved. Alerts routinely name dozens; one marker on the
      // first known zone is honest as long as `coversMultipleZones` says there are more.
      for (const code of zones) {
        const cached = zoneMap[code];
        if (cached) {
          position = { longitude: cached.longitude, latitude: cached.latitude };
          basis = "zone";
          zoneCode = code;
          break;
        }
      }
    }

    // No polygon and no resolved zone yet: omit rather than guess. It appears in a later poll
    // once the zone has been warmed.
    if (!position) continue;

    const feature: WeatherAlertFeature = {
      id: item.id,
      kind: "weather",
      longitude: position.longitude,
      latitude: position.latitude,
      label: props.event?.trim() || props.headline?.trim() || "Weather alert",
      sourceUrl: item.id.startsWith("https://")
        ? item.id
        : `https://api.weather.gov/alerts/${item.id}`,
      properties: {
        event: props.event ?? null,
        severity: props.severity ?? null,
        urgency: props.urgency ?? null,
        certainty: props.certainty ?? null,
        headline: props.headline ?? null,
        areaDescription: props.areaDesc ?? null,
        effectiveAt: props.effective ?? props.onset ?? props.sent ?? null,
        expiresAt: props.ends ?? props.expires ?? null,
        issuedBy: props.senderName ?? null,
        recommendedResponse: props.response ?? null,
        locationBasis: basis,
        zoneCode,
        coversMultipleZones: zones.length > 1,
      },
    };

    // The endpoint returns all active US alerts and cannot filter by area, so the viewport is
    // applied here.
    if (!withinBbox(feature, query)) continue;
    features.push(feature);
  }

  return applyLimit(features, query);
}

function observedAtFrom(data: AlertsPayload, receivedAt: Date): Date {
  const updated = new Date(data.updated);
  return Number.isNaN(updated.getTime()) ? receivedAt : updated;
}

/** Public mapper, for tests against a captured fixture. Validates, then maps. */
export const normaliseNwsAlerts = normaliseVia(nwsAlertsResponseSchema, mapNwsAlerts);

/**
 * Zones named by this payload that we have never looked up. Exported because it is the piece
 * worth testing directly: the warm-up must be bounded and must not re-request known zones.
 */
export function unresolvedZones(
  raw: unknown,
  limit = MAX_ZONE_LOOKUPS_PER_POLL,
): readonly string[] {
  const parsed = nwsAlertsResponseSchema.safeParse(raw);
  if (!parsed.success) return [];
  const zoneMap = currentZoneMap();

  const wanted: string[] = [];
  for (const item of parsed.data.features) {
    if (item.geometry) continue;
    const zones = (item.properties.geocode?.UGC ?? []).filter((code) => UGC_PATTERN.test(code));
    // Only the FIRST zone of each alert: that is all the mapper needs to place a marker, and
    // resolving every zone of a 40-county flood watch would spend the whole budget on one alert.
    const first = zones[0];
    if (!first) continue;
    if (first in zoneMap) continue;
    if (wanted.includes(first)) continue;
    wanted.push(first);
    if (wanted.length >= limit) break;
  }
  return wanted;
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const nwsAlerts: SourceAdapter<WeatherAlertFeature> = {
  slug: NWS_ALERTS_SLUG,
  name: "NWS active weather alerts",
  kind: "weather",
  homepage: "https://www.weather.gov/",
  attribution: {
    text: "Weather alerts: NOAA / US National Weather Service",
    href: "https://www.weather.gov/",
    licence: "public domain (US Government)",
  },
  /**
   * The upstream sends `Cache-Control: max-age=2`, which is a CDN directive rather than an
   * invitation to poll twice a second. 60s is our own conservative floor against an
   * unpublished limit, and it is well inside the useful life of a warning measured in tens
   * of minutes.
   */
  ttlSeconds: 60,
  responseSchema: nwsAlertsResponseSchema,
  normalise: normaliseNwsAlerts,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<WeatherAlertFeature>> {
    const outcome = await fetchUpstream({
      slug: NWS_ALERTS_SLUG,
      url: ALERTS_URL,
      signal: ctx.signal,
      headers: { accept: "application/geo+json" },
      // The full active-alert collection was 1.6 MB on 2026-08-31. The cap is above that
      // with room, and well below anything that would trouble the worker.
      maxBytes: 8 * 1024 * 1024,
    });
    if (!outcome.ok) {
      return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(NWS_ALERTS_SLUG) };
    }

    const decoded = decodeJson(outcome.text);
    if (!decoded.ok) {
      return { ok: false, failure: decoded.failure, lastGoodAt: lastGoodAt(NWS_ALERTS_SLUG) };
    }

    const parsed = parseWith(nwsAlertsResponseSchema, decoded.body);
    if (!parsed.ok) {
      return { ok: false, failure: parsed.failure, lastGoodAt: lastGoodAt(NWS_ALERTS_SLUG) };
    }

    /**
     * Load the durable zone map, then warm a bounded slice of it BEFORE mapping, so zones
     * resolved on this poll place their alerts now rather than next time.
     */
    await loadZoneMap(ctx.cache);

    const wanted = unresolvedZones(parsed.data);
    if (wanted.length > 0) {
      const zoneMap = currentZoneMap();
      for (const ugc of wanted) {
        if (ctx.signal.aborted) break;
        zoneMap[ugc] = await fetchZone(ugc, ctx);
      }
      await setJson(ctx.cache, ZONE_CACHE_KEY, zoneMap, ZONE_CACHE_TTL_SECONDS);
    }

    const features = mapNwsAlerts(parsed.data, query);
    const observedAt = observedAtFrom(parsed.data, new Date());
    recordGood(NWS_ALERTS_SLUG, observedAt);
    return { ok: true, features, observedAt };
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(nwsAlerts, ctx);
  },
};
