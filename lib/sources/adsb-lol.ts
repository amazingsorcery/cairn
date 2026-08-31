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
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — re-confirmed 2026-08-31. Full record in `docs/sources/adsb-lol.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      ODbL 1.0. The service's own OpenAPI document (api.adsb.lol/api/openapi.json,
 *              re-read 2026-08-31) declares "Open Data Commons Open Database License (ODbL)
 *              v1.0" and states: "The license for the API as well as all data ADSB.lol makes
 *              public is ODbL. This is the same license OpenStreetMap uses."
 *              ODbL makes attribution a CONDITION OF USE — a missing credit here is a licence
 *              breach, not a polish defect.
 * Key          None today. "You can use the API for free. In the future, you will require an
 *              API key which you can get by feeding to adsb.lol."
 * Rate limit   NOT PUBLISHED, and this is the source that taught us what that costs.
 *              v1 measured, 2026-08-31: a 25-request burst was refused from the THIRD
 *              request; 10 requests/minute spaced 6s apart still drew 2 refusals in 8; the
 *              limiter refills like a token bucket. No `Retry-After` on a 429 and no
 *              `X-RateLimit-*` headers. QA finding Q-02 recorded 57 refusals — 29% of all
 *              outbound calls — under an envelope whose stated basis was simply wrong.
 * Access ctrl  None circumvented. One documented JSON endpoint, no scraping, no auth.
 * Production   The docs ask production users to make contact first. Recorded in
 *              `docs/sources/adsb-lol.md` as an action for the operator BEFORE this layer is
 *              enabled — it is a request from the upstream, not an optional courtesy.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE TTL IS 30s AND NOT THE BRIEF'S 5–10s. Product-brief §2b targets 5–10s for
 * aircraft. That target cannot be met against this upstream without being refused: 5s
 * polling is 12 requests/minute, and 10/minute already drew refusals under measurement. The
 * brief's own rule — "poll intervals respect each source's documented limits", and measure
 * conservatively where none is published — outranks its illustrative number. 30s gives 2
 * calls/minute per viewport, so up to three viewports stay inside the 6/minute ceiling v1
 * settled on. **Adding a fourth viewport at this TTL breaches that ceiling**, which is why
 * the ceiling is written here next to the arithmetic rather than left implicit.
 *
 * Aircraft positions 30 seconds old are genuinely stale — a jet covers about 4 km in that
 * time — and the UI must show the age rather than imply live-ness. That is an honest cost of
 * respecting a limiter we do not control, and the alternative is being blocked.
 *
 * ADR 0011 rule 8 — LIVE MEANS LIVE. Nothing here is persisted. No table of positions,
 * tracks, callsigns or registrations, and no identity resolution on top of them.
 */

const BASE_URL = "https://api.adsb.lol";

/** The upstream's own documented maximum radius, in nautical miles. */
const MAX_RADIUS_NM = 250;

/**
 * A polled viewport.
 *
 * Derived from `query.bbox` on every call, so the registry holds ONE aircraft source rather
 * than a pre-bound instance per area. `AIRCRAFT_VIEWPORT` supplies the fallback for a query
 * with no bbox — a worker polling this layer unprompted still needs somewhere to look.
 */
export type Viewport = {
  readonly latitude: number;
  readonly longitude: number;
  /** Nautical miles. */
  readonly radiusNm: number;
};

/**
 * Quantise a viewport before it reaches a URL.
 *
 * One decimal place is roughly 11 km. This is not sloppiness: it bounds the number of
 * distinct upstream requests a configuration can produce, and it is the same reasoning
 * `lib/connectors/flights.ts` records — full precision would give every viewport its own
 * upstream call and make the ceiling unenforceable.
 */
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
    /**
     * Documented as integer | string | null: it carries the literal `"ground"` for an
     * aircraft on the surface, which is why the string arm exists.
     */
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

/**
 * `ac` and `now` are REQUIRED, exactly as v1 reasoned: defaulting either would let a
 * response of a different shape parse as "zero aircraft", and the map would render an empty,
 * confident, wrong sky.
 */
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
    // An aircraft with no position cannot be drawn. Dropping it here rather than in the
    // component keeps the "how many are on screen" count honest.
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
        // "none" is the upstream's way of saying there is no emergency. Rendering the word
        // "none" next to an aircraft would read as a state rather than an absence.
        emergency: item.emergency && item.emergency !== "none" ? item.emergency : null,
        positionAgeSeconds: item.seen_pos ?? null,
      },
    });
  }

  /**
   * No `withinBbox` here, deliberately: the upstream has ALREADY filtered to the circle we
   * asked for. Re-clipping to the rectangle would discard aircraft the caller has already
   * paid for, and would make the rendered count disagree with the radius actually queried.
   * `query.limit` still applies, since the endpoint has no limit parameter.
   */
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
 * The fallback viewport when a query carries no bbox: greater London, 250 nm.
 *
 * Any default is arbitrary and this one is stated as such rather than dressed up. It is a
 * dense, well-fed patch of airspace, so an operator switching the layer on immediately sees
 * whether it works. `AIRCRAFT_VIEWPORT` (`"lat,lon,radiusNm"`) moves it without a deploy, and
 * the value is parsed to numbers and clamped before it can reach a URL.
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
    // A malformed configuration falls back rather than failing the worker's boot. The
    // operator sees the default viewport, which is a visible symptom, not a silent one.
    return DEFAULT_VIEWPORT;
  }
  return quantiseViewport({ latitude, longitude, radiusNm });
}

const METRES_PER_NM = 1852;
const EARTH_RADIUS_M = 6_371_000;

/**
 * A bounding box becomes a centre and a radius, because that is the only shape this endpoint
 * accepts.
 *
 * The radius reaches the CORNER of the box, so the circle contains the whole rectangle. An
 * inscribed circle would silently omit aircraft near the corners — the quiet-incompleteness
 * failure this codebase has already been bitten by once, on the weather layer. The cost is
 * some aircraft outside the box, which `mapAdsbLol` deliberately does not clip away: the
 * caller asked to look at an area, and context around its edges is useful rather than wrong.
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
    // ODbL requires attribution. This string is a licence condition, not a nicety.
    text: "Aircraft data from adsb.lol, licensed under ODbL 1.0",
    href: "https://www.adsb.lol/",
    licence: "ODbL 1.0",
  },
  /** See the arithmetic at the top of this file. 2 calls/minute per viewport. */
  ttlSeconds: 30,
  /**
   * Three minutes. An aircraft position is worthless within minutes — at cruise this is
   * already ~24 km of travel — so showing a stale one is worse than showing none.
   */
  staleWhileRevalidateSeconds: 180,
  responseSchema: adsbLolResponseSchema,
  normalise: normaliseAdsbLol,

  fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<AircraftFeature>> {
    const view = resolveViewport(query, ctx.env);

    /**
     * The path is built from numbers already clamped by `quantiseViewport`, then encoded.
     * There is no string from configuration in it — but `encodeURIComponent` is applied
     * anyway, because "the type says it is a number" is exactly the assumption that stops
     * being true after a refactor.
     */
    const url =
      `${BASE_URL}/v2/lat/${encodeURIComponent(view.latitude)}` +
      `/lon/${encodeURIComponent(view.longitude)}` +
      `/dist/${encodeURIComponent(view.radiusNm)}`;

    return pollJson({
      slug: ADSB_LOL_SLUG,
      url,
      ctx,
      schema: adsbLolResponseSchema,
      // A 250 nm circle over London was 90 KB on 2026-08-31; the busiest airspace on earth
      // will not approach this cap.
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
