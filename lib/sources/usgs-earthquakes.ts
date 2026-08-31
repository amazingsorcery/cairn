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
 * USGS earthquakes — the real-time GeoJSON summary feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-08-31. Full record in `docs/sources/usgs-earthquakes.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      Public domain. USGS-authored data and information are in the U.S. public
 *              domain (usgs.gov/information-policies-and-instructions/copyrights-and-credits,
 *              read 2026-08-31). Credit is *requested*, not a licence condition — we render
 *              it anyway, because a reader needs to know whose seismic network said this.
 * Key          None. No registration, no key, no terms-of-use gate.
 * Rate limit   No published request limit. The feed itself answers
 *              `Cache-Control: public, max-age=60` and the documentation says every summary
 *              feed is "updated every minute" — so 60s is the upstream's own number, read
 *              off its own response, not a guess. Matches product-brief §2b ("quakes ~60s").
 * Access ctrl  None circumvented: one documented public JSON endpoint, no scraping, no auth.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHICH FEED. `all_hour` would be the freshest but returns only the last 60 minutes, so a
 * map opened at a quiet moment shows an empty world and looks broken. `2.5_day` is the
 * standard significant-events feed: everything magnitude 2.5+ in the last 24 hours, tens of
 * features rather than thousands, and it is what a reader means by "recent earthquakes".
 * `USGS_QUAKE_FEED` can move it to another documented summary feed without a deploy.
 */

const FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

/**
 * The documented summary feeds. An allowlist rather than a free-text env var: the value is
 * interpolated into a URL, and "operator-supplied string in a server-side fetch URL" is the
 * SSRF shape ADR 0019 names as v2's top risk. Only these strings can ever be reached.
 */
const FEEDS = [
  "all_hour",
  "all_day",
  "1.0_day",
  "2.5_day",
  "4.5_day",
  "significant_day",
  "all_week",
  "1.0_week",
  "2.5_week",
  "4.5_week",
  "significant_week",
  "all_month",
  "2.5_month",
  "4.5_month",
  "significant_month",
] as const;
type Feed = (typeof FEEDS)[number];

const DEFAULT_FEED: Feed = "2.5_day";

function selectedFeed(): Feed {
  const requested = process.env.USGS_QUAKE_FEED?.trim();
  return FEEDS.find((feed) => feed === requested) ?? DEFAULT_FEED;
}

/* ------------------------------------------------------------------ *
 * Upstream schema
 * ------------------------------------------------------------------ */

/**
 * Validated at the boundary (product-brief §5).
 *
 * `mag`, `place` and `alert` are nullable in real payloads and are typed that way rather
 * than defaulted. `metadata.generated` and `features` are REQUIRED: defaulting either would
 * let a response of a completely different shape parse as "zero earthquakes", and an empty,
 * confident, wrong map is worse than a layer that says it is unavailable.
 *
 * `.passthrough()` is deliberate — an upstream that ADDS a field must not break us, only one
 * that removes or retypes what we read.
 */
const quakePropertiesSchema = z
  .object({
    mag: z.number().nullish(),
    place: z.string().nullish(),
    time: z.number().nullish(),
    updated: z.number().nullish(),
    url: z.string().nullish(),
    felt: z.number().nullish(),
    cdi: z.number().nullish(),
    mmi: z.number().nullish(),
    alert: z.string().nullish(),
    status: z.string().nullish(),
    tsunami: z.number().nullish(),
    sig: z.number().nullish(),
    net: z.string().nullish(),
    magType: z.string().nullish(),
    type: z.string().nullish(),
    title: z.string().nullish(),
  })
  .passthrough();

const quakeFeatureSchema = z
  .object({
    id: z.string(),
    properties: quakePropertiesSchema,
    geometry: z
      .object({
        // GeoJSON Point: [longitude, latitude, depth in km].
        coordinates: z.array(z.number().nullable()),
      })
      .nullable(),
  })
  .passthrough();

export const usgsResponseSchema = z
  .object({
    metadata: z
      .object({
        /** Upstream clock, milliseconds since the epoch. This is `observedAt`. */
        generated: z.number(),
        title: z.string().optional(),
        count: z.number().optional(),
      })
      .passthrough(),
    features: z.array(quakeFeatureSchema),
  })
  .passthrough();

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface EarthquakeFeature extends SourceFeature {
  readonly kind: "earthquakes";
  readonly properties: {
    /** Richter-family magnitude. Null when the event has no computed magnitude yet. */
    readonly magnitude: number | null;
    readonly magnitudeType: string | null;
    /** Kilometres below the surface. Shallow quakes do more damage at equal magnitude. */
    readonly depthKm: number | null;
    readonly place: string | null;
    /** ISO 8601. When the earthquake happened, not when we fetched it. */
    readonly occurredAt: string | null;
    readonly updatedAt: string | null;
    /** "reviewed" once a seismologist has checked it; "automatic" until then. */
    readonly reviewStatus: string | null;
    /** PAGER alert level: green / yellow / orange / red. Null for most events. */
    readonly alertLevel: string | null;
    /** USGS's own significance score, 0–1000. Drives sorting in the table view. */
    readonly significance: number | null;
    /** True when the event carried a tsunami flag. Not a tsunami warning in itself. */
    readonly tsunamiFlagged: boolean;
    /** Count of "did you feel it?" reports. */
    readonly feltReports: number | null;
    readonly network: string | null;
  };
}

function isoOrNull(millis: number | null | undefined): string | null {
  if (typeof millis !== "number" || !Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normaliseUsgs(raw: unknown, receivedAt: Date = new Date()): NormaliseOutcome<EarthquakeFeature> {
  const parsed = parseWith(usgsResponseSchema, raw);
  if (!parsed.ok) return parsed;

  const features: EarthquakeFeature[] = [];
  for (const item of parsed.data.features) {
    const coordinates = item.geometry?.coordinates ?? [];
    const depth = coordinates[2];
    // An event with no position cannot be drawn. Dropping it here rather than in the
    // component keeps the "how many are on screen" count honest.
    const position = coordinatePair(coordinates[0], coordinates[1]);
    if (!position) continue;

    const props = item.properties;
    const magnitude = typeof props.mag === "number" && Number.isFinite(props.mag) ? props.mag : null;

    features.push({
      id: item.id,
      kind: "earthquakes",
      longitude: position.longitude,
      latitude: position.latitude,
      /**
       * `SourceFeature.altitude` is documented as metres. A quake's depth is *below* the
       * surface, so it is a negative altitude — writing the positive kilometre figure here
       * would put every earthquake in the stratosphere on any layer that reads this field.
       * The honest kilometre depth stays in `properties.depthKm`.
       */
      ...(typeof depth === "number" && Number.isFinite(depth) ? { altitude: -depth * 1000 } : {}),
      label: props.title?.trim() || `M ${magnitude ?? "?"} — ${props.place ?? "unknown location"}`,
      ...(props.url ? { sourceUrl: props.url } : {}),
      properties: {
        magnitude,
        magnitudeType: props.magType ?? null,
        depthKm: typeof depth === "number" && Number.isFinite(depth) ? depth : null,
        place: props.place ?? null,
        occurredAt: isoOrNull(props.time),
        updatedAt: isoOrNull(props.updated),
        reviewStatus: props.status ?? null,
        alertLevel: props.alert ?? null,
        significance: typeof props.sig === "number" ? props.sig : null,
        tsunamiFlagged: props.tsunami === 1,
        feltReports: typeof props.felt === "number" ? props.felt : null,
        network: props.net ?? null,
      },
    });
  }

  const generated = new Date(parsed.data.metadata.generated);
  return {
    ok: true,
    features,
    observedAt: Number.isNaN(generated.getTime()) ? receivedAt : generated,
  };
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const USGS_EARTHQUAKES_SLUG = "usgs-earthquakes";

export const usgsEarthquakes: PollAdapter<EarthquakeFeature> = {
  slug: USGS_EARTHQUAKES_SLUG,
  name: "USGS earthquakes",
  kind: "earthquakes",
  homepage: "https://earthquake.usgs.gov/earthquakes/map/",
  attribution: {
    // Wording taken from the USGS credits page's own recommended form.
    text: "Earthquake data: U.S. Geological Survey",
    href: "https://earthquake.usgs.gov/earthquakes/feed/",
    licence: "public domain (US Government)",
  },
  /** The feed's own `Cache-Control: max-age=60`, and its documented one-minute update. */
  ttlSeconds: 60,
  responseSchema: usgsResponseSchema,
  normalise: normaliseUsgs,

  fetch(signal: AbortSignal): Promise<SourceResult<EarthquakeFeature>> {
    return pollJson<EarthquakeFeature>({
      slug: USGS_EARTHQUAKES_SLUG,
      url: `${FEED_BASE}/${selectedFeed()}.geojson`,
      signal,
      normalise: normaliseUsgs,
    });
  },

  healthcheck(signal: AbortSignal) {
    return healthcheckByFetch(usgsEarthquakes, signal);
  },
};
