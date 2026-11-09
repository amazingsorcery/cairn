import { z } from "zod";

import { applyLimit, coordinatePair, healthcheckByFetch, normaliseVia, pollJson } from "./adapter";
import type {
  SourceAdapter,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * adsb.lol — community ADS-B aircraft positions.
 *
 * Terms (checked 2026-08-31):
 * Licence      ODbL 1.0 per the OpenAPI document; attribution is a condition of use.
 * Key          None today (may be required in future).
 * Rate limit   Not published. Measured: a 25-request burst refused from the 3rd request;
 *              10/min still drew refusals; token-bucket refill; no Retry-After or
 *              X-RateLimit headers.
 * Production   The docs ask production users to make contact first; do so before enabling.
 *
 * TTL is 30s: faster polling gets refused. 2 calls/min per viewport, so three viewports fit
 * the 6/min ceiling; a fourth would breach it. The UI must show position age.
 *
 * Nothing is persisted, and no identity resolution is added.
 */

const BASE_URL = "https://api.adsb.lol";

/** The upstream's own documented maximum radius, in nautical miles. */
const MAX_RADIUS_NM = 250;

/**
 * A polled viewport, derived from `query.bbox` per call. `AIRCRAFT_VIEWPORT` is the fallback
 * when there's no bbox.
 */
export type Viewport = {
  readonly latitude: number;
  readonly longitude: number;
  /** Nautical miles. */
  readonly radiusNm: number;
};

/** Quantise to 0.1° (~11 km) to bound the number of distinct upstream requests. */
export function quantiseViewport(viewport: Viewport): Viewport {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
  return {
    latitude: Math.round(clamp(viewport.latitude, -90, 90) * 10) / 10,
    longitude: Math.round(clamp(viewport.longitude, -180, 180) * 10) / 10,
    radiusNm: Math.round(clamp(viewport.radiusNm, 1, MAX_RADIUS_NM)),
  };
}

/* ------------------------------------------------------------------ *
 * Upstream schema
 * ------------------------------------------------------------------ */

const aircraftSchema = z
  .object({
    hex: z.string(),
    flight: z.string().nullish(),
    r: z.string().nullish(),
    t: z.string().nullish(),
    lat: z.number().nullish(),
    lon: z.number().nullish(),
    /** integer | "ground" | null. */
    alt_baro: z.union([z.number(), z.string()]).nullish(),
    alt_geom: z.number().nullish(),
    gs: z.number().nullish(),
    track: z.number().nullish(),
    baro_rate: z.number().nullish(),
    squawk: z.string().nullish(),
    emergency: z.string().nullish(),
    category: z.string().nullish(),
    seen_pos: z.number().nullish(),
  })
  .passthrough();

/** `ac` and `now` are required so a wrong-shaped response doesn't parse as zero aircraft. */
export const adsbLolResponseSchema = z
  .object({
    ac: z.array(aircraftSchema),
    /** Upstream clock, milliseconds since the epoch. */
    now: z.number(),
    total: z.number().optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface AircraftFeature extends SourceFeature {
  readonly kind: "aircraft";
  readonly properties: {
    /** ICAO 24-bit address, lower case. Stable identity across polls. */
    readonly icao24: string;
    /** Broadcast by the aircraft itself. Not resolved to an operator by us. */
    readonly callsign: string | null;
    readonly registration: string | null;
    /** ICAO type code, e.g. B738. */
    readonly aircraftType: string | null;
    /** Feet. Null when on the ground or not reported. */
    readonly altitudeFt: number | null;
    readonly onGround: boolean;
    readonly groundSpeedKt: number | null;
    readonly trackDeg: number | null;
    /** Feet per minute. Negative is a descent. */
    readonly verticalRateFpm: number | null;
    readonly squawk: string | null;
    /** The upstream's own emergency-squawk interpretation, passed through unaltered. */
    readonly emergency: string | null;
    /** Seconds since this aircraft's position was last received. The per-aircraft age. */
    readonly positionAgeSeconds: number | null;
  };
}

/** Feet to metres, for `SourceFeature.altitude`, which the contract documents as metres. */
const FEET_TO_METRES = 0.3048;

type AdsbPayload = z.infer<typeof adsbLolResponseSchema>;

/** Map validated data to features. `fetch` has already decided the payload is well-shaped. */
function mapAdsbLol(data: AdsbPayload, query: SourceQuery): readonly AircraftFeature[] {
  const features: AircraftFeature[] = [];
  for (const item of data.ac) {
    const position = coordinatePair(item.lon, item.lat);
    // No position, can't be drawn; drop here so the count is right.
    if (!position) continue;

    const onGround = item.alt_baro === "ground";
    const altitudeFt = typeof item.alt_baro === "number" ? item.alt_baro : null;
    const callsign = item.flight?.trim() || null;
    const registration = item.r?.trim() || null;

    features.push({
      id: item.hex,
      kind: "aircraft",
      longitude: position.longitude,
      latitude: position.latitude,
      ...(altitudeFt !== null ? { altitude: altitudeFt * FEET_TO_METRES } : {}),
      label: callsign || registration || item.hex.toUpperCase(),
      sourceUrl: `https://globe.adsb.lol/?icao=${encodeURIComponent(item.hex)}`,
      properties: {
        icao24: item.hex,
        callsign,
        registration,
        aircraftType: item.t?.trim() || null,
        altitudeFt,
        onGround,
        groundSpeedKt: item.gs ?? null,
        trackDeg: item.track ?? null,
        verticalRateFpm: item.baro_rate ?? null,
        squawk: item.squawk ?? null,
        // "none" means no emergency.
        emergency: item.emergency && item.emergency !== "none" ? item.emergency : null,
        positionAgeSeconds: item.seen_pos ?? null,
      },
    });
  }

  // No bbox clipping: the upstream already filtered to the circle. The endpoint has no limit
  // param, so `query.limit` is applied here.
  return applyLimit(features, query);
}

function observedAtFrom(data: AdsbPayload, receivedAt: Date): Date {
  const observed = new Date(data.now);
  return Number.isNaN(observed.getTime()) ? receivedAt : observed;
}

/** Public mapper, for tests against a captured fixture. Validates, then maps. */
export const normaliseAdsbLol = normaliseVia(adsbLolResponseSchema, mapAdsbLol);

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const ADSB_LOL_SLUG = "adsb-lol";

/**
 * Fallback viewport: London, 250 nm (arbitrary, but busy airspace). Override with
 * `AIRCRAFT_VIEWPORT="lat,lon,radiusNm"`; parsed and clamped before use.
 */
export const DEFAULT_VIEWPORT: Viewport = { latitude: 51.5, longitude: -0.1, radiusNm: 250 };

export function viewportFromEnv(raw: string | undefined): Viewport {
  if (!raw) return DEFAULT_VIEWPORT;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  const [latitude, longitude, radiusNm] = parts;
  if (
    parts.length !== 3 ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof radiusNm !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(radiusNm)
  ) {
    // Malformed config falls back rather than failing worker boot.
    return DEFAULT_VIEWPORT;
  }
  return quantiseViewport({ latitude, longitude, radiusNm });
}

const METRES_PER_NM = 1852;
const EARTH_RADIUS_M = 6_371_000;

/**
 * Bbox to centre + radius (the only shape the endpoint accepts). The radius reaches the
 * corner so the circle contains the whole box; extra aircraft outside it are kept.
 */
export function viewportFromBbox(bbox: NonNullable<SourceQuery["bbox"]>): Viewport {
  const latitude = (bbox.north + bbox.south) / 2;
  const longitude = (bbox.east + bbox.west) / 2;

  const latSpanM = ((bbox.north - bbox.south) * Math.PI * EARTH_RADIUS_M) / 180;
  // Longitude degrees shrink toward the poles, so the span is scaled by cos(latitude).
  const lonSpanM =
    ((bbox.east - bbox.west) * Math.PI * EARTH_RADIUS_M * Math.cos((latitude * Math.PI) / 180)) /
    180;
  const cornerM = Math.hypot(latSpanM, lonSpanM) / 2;

  return quantiseViewport({
    latitude,
    longitude,
    radiusNm: Math.max(1, Math.ceil(cornerM / METRES_PER_NM)),
  });
}

/** The viewport this call will poll: the query's bbox, else the configured fallback. */
export function resolveViewport(query: SourceQuery, env: SourceContext["env"]): Viewport {
  return query.bbox ? viewportFromBbox(query.bbox) : viewportFromEnv(env("AIRCRAFT_VIEWPORT"));
}

export const adsbLol: SourceAdapter<AircraftFeature> = {
  slug: ADSB_LOL_SLUG,
  name: "adsb.lol aircraft",
  kind: "aircraft",
  homepage: "https://www.adsb.lol/",
  attribution: {
    // Required by ODbL.
    text: "Aircraft data from adsb.lol, licensed under ODbL 1.0",
    href: "https://www.adsb.lol/",
    licence: "ODbL 1.0",
  },
  /** 2 calls/minute per viewport; see the header. */
  ttlSeconds: 30,
  /** Short: a 3-minute-old position is already ~24 km off at cruise. */
  staleWhileRevalidateSeconds: 180,
  responseSchema: adsbLolResponseSchema,
  normalise: normaliseAdsbLol,

  fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<AircraftFeature>> {
    const view = resolveViewport(query, ctx.env);

    // Clamped numbers, encoded anyway in case that changes.
    const url =
      `${BASE_URL}/v2/lat/${encodeURIComponent(view.latitude)}` +
      `/lon/${encodeURIComponent(view.longitude)}` +
      `/dist/${encodeURIComponent(view.radiusNm)}`;

    return pollJson({
      slug: ADSB_LOL_SLUG,
      url,
      ctx,
      schema: adsbLolResponseSchema,
      // 250 nm over London was ~90 KB.
      maxBytes: 4 * 1024 * 1024,
      map: (data, receivedAt) => ({
        features: mapAdsbLol(data, query),
        observedAt: observedAtFrom(data, receivedAt),
      }),
    });
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(adsbLol, ctx);
  },
};
