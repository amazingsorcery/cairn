import { z } from "zod";

import { sourceUserAgent } from "@/lib/sources/http";

import type { Connector } from "@/db/schema";
import { connectorHost } from "@/lib/toolbench/net-target";

import { UpstreamStatusError } from "./runtime";
import { upstreamGet } from "./upstream";
import type { ConnectorDriver } from "./types";

/**
 * `/live/flights`: open ADS-B aircraft positions from adsb.lol.
 *
 * Notes (verified 2026-08-31 against `https://api.adsb.lol/api/openapi.json`):
 * - Endpoint `/v2/lat/{lat}/lon/{lon}/dist/{radius}`; radius in nautical miles, max 250.
 * - No API key today (may be required in future; use `api_key_env_var` then).
 * - API and data are ODbL 1.0, so attribution is required. Feeders grant CC0 on their
 *   contributions; we apply the stricter ODbL.
 * - robots.txt on the API host is 404.
 * - Rate limits are "dynamic based on load", so the ceiling is low and the payload is shared
 *   across viewers.
 *
 * Not a legal opinion; `connectors.legal_basis` records what was read and when.
 *
 * Nothing is persisted: no table of positions, tracks or registrations. The payload lives only
 * in the in-process cache in `runtime.ts`, for at most `ttl + swr`.
 */

/* ------------------------------------------------------------------ *
 * Request parameters
 * ------------------------------------------------------------------ */

/**
 * The viewport is quantised (lat/lon to 0.1°, ~11 km; radius to a ladder) because it's the
 * shared cache key. Full precision would mean one entry, and one upstream call, per viewer.
 */
const RADIUS_LADDER = [25, 50, 100, 150, 250] as const;

export const flightParamsSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** Nautical miles. The upstream's own documented maximum is 250. */
  radius: z.coerce.number().min(1).max(250).default(50),
});

export type FlightParams = { lat: number; lon: number; radius: number };

function quantise(raw: unknown): FlightParams {
  const parsed = flightParamsSchema.parse(raw);
  const radius: number = RADIUS_LADDER.find((step) => parsed.radius <= step) ?? 250;
  return {
    lat: Math.round(parsed.lat * 10) / 10,
    lon: Math.round(parsed.lon * 10) / 10,
    radius,
  };
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

/**
 * Upstream response, validated since the shape can change without notice. `.passthrough()`
 * so added fields don't break us; only removed or retyped ones do.
 */
const aircraftSchema = z
  .object({
    hex: z.string(),
    flight: z.string().nullish(),
    r: z.string().nullish(),
    t: z.string().nullish(),
    lat: z.number().nullish(),
    lon: z.number().nullish(),
    // integer | "ground" | null.
    alt_baro: z.union([z.number(), z.string()]).nullish(),
    gs: z.number().nullish(),
    track: z.number().nullish(),
    squawk: z.string().nullish(),
    emergency: z.string().nullish(),
    seen_pos: z.number().nullish(),
  })
  .passthrough();

/**
 * `ac` and `now` are required, not defaulted: a defaulted `ac` would make any wrong-shaped
 * response parse as "zero aircraft" instead of unavailable.
 */
const responseSchema = z.object({
  ac: z.array(aircraftSchema),
  /** Upstream clock, milliseconds since the epoch. */
  now: z.number(),
  total: z.number().optional(),
});

/**
 * Trimmed payload: only the fields the surface renders.
 *
 * `registration` and `callsign` are broadcast in the clear. We add no identity resolution on
 * top (no owner lookup, no history).
 */
export type Aircraft = {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  lat: number;
  lon: number;
  /** Feet. Null when the aircraft reports "ground" or omits the field. */
  altitudeFt: number | null;
  onGround: boolean;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  squawk: string | null;
  /** The upstream's own emergency squawk interpretation, passed through unaltered. */
  emergency: string | null;
  /** Seconds since this aircraft's position was last received. The per-aircraft age. */
  positionAgeSeconds: number | null;
};

export type FlightsPayload = {
  aircraft: Aircraft[];
  /** What the upstream said it returned, which may exceed what it sent. */
  reportedTotal: number | null;
  /** The viewport this payload actually covers, after quantisation. */
  viewport: FlightParams;
};

function trim(parsed: z.infer<typeof responseSchema>, params: FlightParams): FlightsPayload {
  const aircraft: Aircraft[] = [];

  for (const item of parsed.ac) {
    // No position, can't be drawn; drop here so the on-screen count is right.
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;

    const onGround = item.alt_baro === "ground";
    aircraft.push({
      hex: item.hex,
      callsign: item.flight?.trim() || null,
      registration: item.r?.trim() || null,
      type: item.t?.trim() || null,
      lat: item.lat,
      lon: item.lon,
      altitudeFt: typeof item.alt_baro === "number" ? item.alt_baro : null,
      onGround,
      groundSpeedKt: item.gs ?? null,
      trackDeg: item.track ?? null,
      squawk: item.squawk ?? null,
      emergency: item.emergency && item.emergency !== "none" ? item.emergency : null,
      positionAgeSeconds: item.seen_pos ?? null,
    });
  }

  return {
    aircraft,
    reportedTotal: parsed.total ?? null,
    viewport: params,
  };
}

/* ------------------------------------------------------------------ *
 * The driver
 * ------------------------------------------------------------------ */

export const FLIGHTS_CONNECTOR_SLUG = "adsb-lol";

/** The only host this driver sends to; `connector.baseUrl` and every redirect hop are checked against it. */
const FLIGHTS_HOST = "api.adsb.lol";

export const flightsDriver: ConnectorDriver<FlightParams, FlightsPayload> = {
  kind: "flights",
  slug: FLIGHTS_CONNECTOR_SLUG,
  normalise: quantise,

  /**
   * One shared entry per quantised cell, with nothing about the caller. Reads aren't free:
   * `runConnector` charges quota before the cache so a hit can't reveal that someone else
   * was watching that cell.
   */
  cacheKey: (p) => `${p.lat.toFixed(1)},${p.lon.toFixed(1)},${p.radius}`,

  async fetch(connector: Connector, params, signal) {
    // Path params are Zod-bounded numbers; encoded anyway in case that changes.
    const base = connector.baseUrl.replace(/\/+$/, "");
    // Never send to an unrecognised host, whatever the registry row says.
    if (connectorHost(base) !== FLIGHTS_HOST) {
      throw new UpstreamStatusError(502);
    }
    const url =
      `${base}/v2/lat/${encodeURIComponent(params.lat)}` +
      `/lon/${encodeURIComponent(params.lon)}` +
      `/dist/${encodeURIComponent(params.radius)}`;

    // `upstreamGet` pins the host on every hop, caps the body while streaming, and counts
    // the request for the audit log.
    const response = await upstreamGet({
      url,
      pinnedHost: FLIGHTS_HOST,
      signal,
      // Identifies us (not the viewer) to the operator. Built from `config/brand.ts`.
      userAgent: sourceUserAgent(),
      // Same cap as `lib/sources/adsb-lol.ts`; 250 nm over London was ~90 KB.
      maxBytes: 4 * 1024 * 1024,
    });

    // The primitive reads Retry-After on any non-2xx. adsb.lol currently sends none, so
    // `runtime.ts` falls back to `DEFAULT_COOLDOWN_SECONDS`.
    let body: unknown;
    try {
      body = JSON.parse(response.text) as unknown;
    } catch {
      // Not JSON: shape change, not zero aircraft. Parse error isn't logged (quotes the body).
      throw new UpstreamStatusError(502);
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      // Shape change: degrade. Parse error isn't logged (it would contain the body).
      throw new UpstreamStatusError(502);
    }

    return { data: trim(parsed.data, params), upstreamStatus: response.status };
  },
};

/**
 * Registry row seeded by `db/seed.ts`. Kept beside the driver for review, but it's data:
 * once seeded, operators change it with an UPDATE (no deploy). Seeds disabled (fail closed).
 */
export const FLIGHTS_CONNECTOR_SEED = {
  slug: FLIGHTS_CONNECTOR_SLUG,
  name: "adsb.lol",
  kind: "flights" as const,
  operatorName: "adsb.lol (community ADS-B aggregator)",
  homepageUrl: "https://www.adsb.lol/",
  termsUrl: "https://api.adsb.lol/docs",
  attribution: "Aircraft data from adsb.lol, licensed under ODbL 1.0.",
  attributionRequired: true,
  legalBasis:
    "adsb.lol's API description (read 2026-08-31 at https://api.adsb.lol/api/openapi.json) " +
    "states that the API and all data adsb.lol makes public are licensed under the Open Data " +
    "Commons Open Database Licence (ODbL) v1.0, and that the API may currently be used for " +
    "free without a key. ODbL requires attribution, so attribution is recorded as required " +
    "and is rendered next to the data. adsb.lol's feeder-facing privacy page separately " +
    "describes contributors waiving rights under CC0; where the two differ we apply the " +
    "stricter ODbL terms. No robots.txt is published for api.adsb.lol (404 on 2026-08-31), " +
    "so no crawl directive is being circumvented. The data is ADS-B telemetry broadcast in " +
    "the clear by the aircraft; we add no identity resolution and retain nothing. " +
    "RATE: the upstream publishes no limit ('rate limits are dynamic based on the " +
    "environment load') and sends no Retry-After or X-RateLimit headers, so THEIR LIMITER IS " +
    "THE AUTHORITY AND NOT THESE COLUMNS. A 429 or 420 opens a per-connector cooldown and we " +
    "stop calling until it expires; the surface degrades to a stale or unavailable state that " +
    "says so, and the client stops polling. The columns on this row are a ceiling set below " +
    "the lowest rate at which refusals were observed (2026-08-31: a 25-request burst was " +
    "refused from the 3rd request, and 10 requests/minute spaced 6s apart drew 2 refusals in " +
    "8), not a rate we assert is permitted. An earlier envelope of 20/user/min and 60/min " +
    "global drew 57 HTTP 429s and one 420. NOT A LEGAL OPINION.",
  baseUrl: "https://api.adsb.lol",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /**
   * Measured 2026-08-31: a 25-request burst was refused from the 3rd request, and a smooth
   * 10/min still drew refusals. The limiter is a refilling token bucket. So the global
   * ceiling is 6/min, below the observed floor; the real protection is the cooldown in
   * `runtime.ts`. The payload is shared, so this bounds total upstream traffic.
   *
   * `per_user_quota` counts reads, including cache hits (charged before the cache read), so
   * it matches the global ceiling. Outbound calls are still bounded by `global_ceiling`.
   *
   * A re-seed doesn't reset quota columns; older databases may still say 3:
   * `update connectors set per_user_quota = 6 where slug = 'adsb-lol';`
   */
  perUserQuota: 6,
  globalCeiling: 6,
  windowSeconds: 60,
  timeoutMs: 5000,
  /**
   * 60s TTL: one viewport costs at most one call a minute. 600s stale window so a backoff
   * shows aged positions; past ttl+swr the surface goes `unavailable`.
   */
  cacheTtlSeconds: 60,
  staleWhileRevalidateSeconds: 600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Endpoint and licence confirmed 2026-08-31 against the service's own OpenAPI document " +
    "and one live request. Quota envelope tightened and backoff added after 57 logged 429s " +
    "under the previous settings. Seeded disabled and draft: an operator must review the " +
    "recorded legal basis and turn it on. Set `enabled = " +
    "true` and `status = 'published'` to bring /live/flights up.",
};
