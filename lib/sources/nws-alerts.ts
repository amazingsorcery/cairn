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
 * Terms (checked 2026-08-31):
 * Licence      US Government public domain; "free to use for any purpose".
 * Key          None.
 * User-Agent   Required (identifying string with contact); see `sourceUserAgent()`.
 * Rate limit   Unpublished ("generous"), and proxies like us hit it sooner, so TTL is 60s
 *              with one shared poll for all readers.
 *
 * Only ~1.3% of active alerts carry inline geometry; the rest give only UGC zone codes. So
 * zones are resolved to a point, gently:
 *   - one single-zone request per zone (~19 KB);
 *   - zones are effectively static, so results are cached in `SourceContext.cache`;
 *   - at most `MAX_ZONE_LOOKUPS_PER_POLL` new zones per poll, so coverage fills in over
 *     several polls instead of a ~700-request burst;
 *   - a zone with no usable geometry is cached as a miss.
 *
 * `SourceContext.cache` is per-process, so after a deploy the layer is incomplete for the
 * first few polls while it re-warms.
 */

const ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual";
const ZONE_BASE = "https://api.weather.gov/zones";

/** Bounded per-poll zone warm-up. */
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

/** `features` and `updated` are required so an unrelated document can't parse as "no alerts". */
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

/** UGC code -> point, stored as one cache entry (~45 KB) rather than one key per zone. `null` is a miss. */
const zoneMapSchema = z.record(z.string(), zonePointSchema.nullable());
type ZoneMap = Record<string, ZonePoint | null>;

const ZONE_CACHE_KEY = cacheKey(NWS_ALERTS_SLUG, "zone-points");

/** 30 days: zones are near-static but NWS revises them a few times a year. */
const ZONE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * In-memory view of the zone map. `normalise` is synchronous, so `fetch` loads the shared
 * map from `SourceContext.cache` into this view before mapping.
 */
const globalForZones = globalThis as typeof globalThis & { __cairnNwsZones__?: ZoneMap };
function currentZoneMap(): ZoneMap {
  return (globalForZones.__cairnNwsZones__ ??= {});
}

/**
 * UGC: two letters, `C` (county) or `Z` (zone), three digits. Enforced because the code is
 * interpolated into a server-side fetch URL.
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

/** Load the shared zone map into the view. A miss or bad entry is just a cold start. */
async function loadZoneMap(cache: SourceCache): Promise<void> {
  const stored = await getJson(cache, ZONE_CACHE_KEY, zoneMapSchema);
  if (!stored) return;
  const current = currentZoneMap();
  for (const [ugc, point] of Object.entries(stored)) {
    // Zones resolved in this process win over the stored copy.
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
     * How the point was derived: `polygon` (the alert's own polygon) or `zone` (centroid of
     * the named zone, possibly tens of km off).
     */
    readonly locationBasis: "polygon" | "zone";
    /** The UGC zone the point came from, when the basis is `zone`. */
    readonly zoneCode: string | null;
    /** True when the alert names more zones than the one we placed it on. */
    readonly coversMultipleZones: boolean;
  };
}

type AlertsPayload = z.infer<typeof nwsAlertsResponseSchema>;

/** Map validated alerts using the in-memory zone view. No I/O. */
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
      // Place on the first resolved zone; `coversMultipleZones` flags the rest.
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

    // Not placeable yet; appears once its zone is warmed.
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

    // The endpoint can't filter by area.
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

/** Zones in this payload not yet looked up, bounded by `limit`. Exported for tests. */
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
    // Only each alert's first zone; that's all the mapper needs.
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
  /** Upstream's `max-age=2` is a CDN hint; 60s is our conservative floor. */
  ttlSeconds: 60,
  /** Short, since showing a cancelled warning is dangerous. */
  staleWhileRevalidateSeconds: 600,
  responseSchema: nwsAlertsResponseSchema,
  normalise: normaliseNwsAlerts,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<WeatherAlertFeature>> {
    const outcome = await fetchUpstream({
      slug: NWS_ALERTS_SLUG,
      url: ALERTS_URL,
      signal: ctx.signal,
      headers: { accept: "application/geo+json" },
      // The full collection was ~1.6 MB.
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

    // Warm zones before mapping so newly resolved ones place their alerts this poll.
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
