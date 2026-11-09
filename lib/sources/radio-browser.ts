import { z } from "zod";

import { applyLimit, coordinatePair, healthcheckByFetch, normaliseVia, pollJson, withinBbox } from "./adapter";
import { cacheKey, getJson, setJson } from "./cache";
import { decodeJson, fetchUpstream } from "./http";
import type {
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * Radio Browser — a community catalogue of internet radio stations, with coordinates.
 *
 * Terms (checked 2026-08-31):
 * Licence      Catalogue is public domain ("Data license: public domain, software license:
 *              GPL"). That covers the catalogue, not the stations' audio.
 * Key          None.
 * User-Agent   Asked for: a descriptive agent string.
 * Rate limit   Unpublished; volunteer-run mirrors, so TTL is one hour.
 *
 * - We never fetch or relay audio; the client connects to the station directly.
 * - We never send the `/json/url` click-tracking request, which would tell a third party
 *   which station each reader opened.
 */

/**
 * Server discovery via the HTTP form of the documented lookup (mirrors may change). Falls back
 * to the documented example server if discovery fails.
 */
const DISCOVERY_URL = "https://all.api.radio-browser.info/json/servers";
const FALLBACK_HOST = "de1.api.radio-browser.info";

/** Mirrors change rarely. */
const DISCOVERY_TTL_SECONDS = 60 * 60;

/** Only stations with coordinates can appear on a map at all. */
const STATION_LIMIT = 500;

export const RADIO_BROWSER_SLUG = "radio-browser";

const serverSchema = z.array(z.object({ name: z.string() }).passthrough());

/**
 * Discovered hostnames come from a remote response, so they're pinned to the project's
 * domain before use in a server-side fetch (SSRF).
 */
const HOST_PATTERN = /^[a-z0-9-]+\.api\.radio-browser\.info$/;

export function pickServer(raw: unknown): string {
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) return FALLBACK_HOST;
  const hosts = Array.from(new Set(parsed.data.map((s) => s.name.toLowerCase()))).filter((name) =>
    HOST_PATTERN.test(name),
  );
  if (hosts.length === 0) return FALLBACK_HOST;
  // Spread load across mirrors.
  return hosts[Math.floor(Math.random() * hosts.length)] ?? FALLBACK_HOST;
}

/* ------------------------------------------------------------------ *
 * Upstream schema
 * ------------------------------------------------------------------ */

/** The endpoint returns a bare array with no timestamp, so `observedAt` is our receive time. */
const stationSchema = z
  .object({
    stationuuid: z.string(),
    name: z.string(),
    url: z.string().nullish(),
    url_resolved: z.string().nullish(),
    homepage: z.string().nullish(),
    favicon: z.string().nullish(),
    tags: z.string().nullish(),
    country: z.string().nullish(),
    countrycode: z.string().nullish(),
    state: z.string().nullish(),
    language: z.string().nullish(),
    codec: z.string().nullish(),
    bitrate: z.number().nullish(),
    hls: z.number().nullish(),
    lastcheckok: z.number().nullish(),
    lastcheckoktime_iso8601: z.string().nullish(),
    votes: z.number().nullish(),
    clickcount: z.number().nullish(),
    geo_lat: z.number().nullish(),
    geo_long: z.number().nullish(),
  })
  .passthrough();

export const radioBrowserResponseSchema = z.array(stationSchema);

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface RadioStationFeature extends SourceFeature {
  readonly kind: "radio";
  readonly properties: {
    readonly stationUuid: string;
    /** Stream the client connects to directly (never fetched by us). Prefers `url_resolved`. */
    readonly streamUrl: string;
    /** Whether the stream is HLS, so the client can choose a player. 0/1 upstream. */
    readonly isHls: boolean;
    /**
     * Plain `http:` stream (~20% of stations). Browsers block these as mixed content, so the
     * UI must not offer a play button; show it as a link out instead.
     */
    readonly isInsecureStream: boolean;
    readonly codec: string | null;
    readonly bitrateKbps: number | null;
    readonly homepage: string | null;
    readonly country: string | null;
    readonly countryCode: string | null;
    readonly state: string | null;
    readonly language: string | null;
    /** Comma-separated upstream tag string, passed through as given. */
    readonly tags: string | null;
    /** Whether the project's checker last found the stream playable, and when. */
    readonly lastCheckOk: boolean;
    readonly lastCheckedAt: string | null;
    readonly clickCount: number | null;
  };
}

/** Only http(s) stream URLs are passed on. A `javascript:` or `data:` URL is not a radio. */
function safeStreamUrl(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {
      // Not a URL. Try the next candidate.
    }
  }
  return null;
}

type RadioPayload = z.infer<typeof radioBrowserResponseSchema>;

/** Map validated stations to features. `fetch` has already decided the payload is well-shaped. */
function mapRadioBrowser(data: RadioPayload, query: SourceQuery): readonly RadioStationFeature[] {
  const features: RadioStationFeature[] = [];

  for (const station of data) {
    const position = coordinatePair(station.geo_long, station.geo_lat);
    if (!position) continue;

    // 0,0 means the geo fields were left at default.
    if (position.longitude === 0 && position.latitude === 0) continue;

    const streamUrl = safeStreamUrl(station.url_resolved, station.url);
    if (!streamUrl) continue;

    const feature: RadioStationFeature = {
      id: station.stationuuid,
      kind: "radio",
      longitude: position.longitude,
      latitude: position.latitude,
      label: station.name.trim() || "Unnamed station",
      ...(station.homepage ? { sourceUrl: station.homepage } : {}),
      properties: {
        stationUuid: station.stationuuid,
        streamUrl,
        isHls: station.hls === 1,
        isInsecureStream: streamUrl.startsWith("http://"),
        codec: station.codec ?? null,
        bitrateKbps: typeof station.bitrate === "number" ? station.bitrate : null,
        homepage: station.homepage ?? null,
        country: station.country ?? null,
        countryCode: station.countrycode ?? null,
        state: station.state ?? null,
        language: station.language ?? null,
        tags: station.tags ?? null,
        lastCheckOk: station.lastcheckok === 1,
        lastCheckedAt: station.lastcheckoktime_iso8601 ?? null,
        clickCount: typeof station.clickcount === "number" ? station.clickcount : null,
      },
    };

    // The search endpoint has no bbox parameter, so the viewport is applied here.
    if (!withinBbox(feature, query)) continue;
    features.push(feature);
  }

  return applyLimit(features, query);
}

/** Public mapper, for tests against a captured fixture. Validates, then maps. */
export const normaliseRadioBrowser = normaliseVia(radioBrowserResponseSchema, mapRadioBrowser);

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

const MIRROR_CACHE_KEY = cacheKey(RADIO_BROWSER_SLUG, "mirror");
const mirrorSchema = z.string().regex(HOST_PATTERN);

/** Discover a mirror, cached in `SourceContext.cache`. Falls back on any failure. */
async function currentHost(ctx: SourceContext): Promise<string> {
  const cached = await getJson(ctx.cache, MIRROR_CACHE_KEY, mirrorSchema);
  if (cached) return cached;

  const outcome = await fetchUpstream({
    slug: RADIO_BROWSER_SLUG,
    url: DISCOVERY_URL,
    signal: ctx.signal,
    timeoutMs: 5_000,
  });
  if (!outcome.ok) return FALLBACK_HOST;

  const decoded = decodeJson(outcome.text);
  const host = decoded.ok ? pickServer(decoded.body) : FALLBACK_HOST;
  await setJson(ctx.cache, MIRROR_CACHE_KEY, host, DISCOVERY_TTL_SECONDS);
  return host;
}

/** Test seam: forget the remembered mirror. */
export async function clearServerCache(cache: SourceCache): Promise<void> {
  await cache.set(MIRROR_CACHE_KEY, "", 0);
}

export const radioBrowser: SourceAdapter<RadioStationFeature> = {
  slug: RADIO_BROWSER_SLUG,
  name: "Radio Browser stations",
  kind: "radio",
  homepage: "https://www.radio-browser.info/",
  attribution: {
    // Not required by the licence, but readers should know where the data comes from.
    text: "Station data from the Radio Browser community catalogue",
    href: "https://www.radio-browser.info/",
    licence: "public domain dedication (project maintainer)",
  },
  /** Station metadata changes over days. */
  ttlSeconds: 3600,
  /** A day; a slightly old station list is fine. */
  staleWhileRevalidateSeconds: 86400,
  responseSchema: radioBrowserResponseSchema,
  normalise: normaliseRadioBrowser,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<RadioStationFeature>> {
    const host = await currentHost(ctx);

    // `limit` goes upstream; bbox has no upstream equivalent and is applied in the mapper.
    const limit = Math.min(query.limit ?? STATION_LIMIT, STATION_LIMIT);
    const url =
      `https://${host}/json/stations/search` +
      `?has_geo_info=true&hidebroken=true&order=clickcount&reverse=true&limit=${limit}`;

    return pollJson({
      slug: RADIO_BROWSER_SLUG,
      url,
      ctx,
      schema: radioBrowserResponseSchema,
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
      map: (data, receivedAt) => ({
        features: mapRadioBrowser(data, query),
        // No upstream timestamp; see `stationSchema`.
        observedAt: receivedAt,
      }),
    });
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(radioBrowser, ctx);
  },
};
