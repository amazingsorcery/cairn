import { z } from "zod";

import {
  coordinatePair,
  healthcheckByFetch,
  parseWith,
  pollJson,
  type NormaliseOutcome,
  type PollAdapter,
} from "./adapter";
import type { SourceFeature, SourceResult } from "./types";

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
 * `SourceAdapter.fetch(signal)` takes no parameters, so a viewport-scoped source cannot
 * describe what it is asking for. Rather than fork `types.ts`, the viewport is bound at
 * construction: `createAdsbLolAdapter()` returns a fully-formed adapter for one area, and the
 * registry holds whichever instances an operator wants. Noted in `docs/sources/HANDOFF.md` as
 * proposed friction on the contract.
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

export function normaliseAdsbLol(
  raw: unknown,
  receivedAt: Date = new Date(),
): NormaliseOutcome<AircraftFeature> {
  const parsed = parseWith(adsbLolResponseSchema, raw);
  if (!parsed.ok) return parsed;

  const features: AircraftFeature[] = [];
  for (const item of parsed.data.ac) {
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

  const observed = new Date(parsed.data.now);
  return {
    ok: true,
    features,
    observedAt: Number.isNaN(observed.getTime()) ? receivedAt : observed,
  };
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const ADSB_LOL_SLUG = "adsb-lol";

/**
 * The default viewport: greater London, 250 nm.
 *
 * Any default is arbitrary and this one is stated as such rather than dressed up. It is a
 * dense, well-fed patch of airspace, so an operator switching the layer on immediately sees
 * whether it works. `AIRCRAFT_VIEWPORT` (`"lat,lon,radiusNm"`) moves it without a deploy, and
 * the value is parsed to numbers and clamped before it can reach a URL.
 */
export const DEFAULT_VIEWPORT: Viewport = { latitude: 51.5, longitude: -0.1, radiusNm: 250 };

export function viewportFromEnv(raw: string | undefined = process.env.AIRCRAFT_VIEWPORT): Viewport {
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

/**
 * One adapter per polled viewport.
 *
 * The slug carries the viewport so two instances never share a cache entry or a cooldown
 * key — except for the default, which keeps the bare slug so the registry entry and v1's
 * connector row line up.
 */
export function createAdsbLolAdapter(viewport: Viewport = viewportFromEnv()): PollAdapter<AircraftFeature> {
  const view = quantiseViewport(viewport);
  const isDefault =
    view.latitude === DEFAULT_VIEWPORT.latitude &&
    view.longitude === DEFAULT_VIEWPORT.longitude &&
    view.radiusNm === DEFAULT_VIEWPORT.radiusNm;
  const slug = isDefault
    ? ADSB_LOL_SLUG
    : `${ADSB_LOL_SLUG}:${view.latitude},${view.longitude},${view.radiusNm}`;

  const adapter: PollAdapter<AircraftFeature> = {
    slug,
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
    responseSchema: adsbLolResponseSchema,
    normalise: normaliseAdsbLol,

    fetch(signal: AbortSignal): Promise<SourceResult<AircraftFeature>> {
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

      return pollJson<AircraftFeature>({
        slug,
        url,
        signal,
        // A 250 nm circle over London was 90 KB on 2026-08-31; the busiest airspace on earth
        // will not approach this cap.
        maxBytes: 4 * 1024 * 1024,
        normalise: normaliseAdsbLol,
      });
    },

    healthcheck(signal: AbortSignal) {
      return healthcheckByFetch(adapter, signal);
    },
  };

  return adapter;
}

/** The instance the registry holds. */
export const adsbLol: PollAdapter<AircraftFeature> = createAdsbLolAdapter();
