import { z } from "zod";

import {
  applyLimit,
  coordinatePair,
  healthcheckByFetch,
  normaliseVia,
  pollJson,
  withinBbox,
} from "./adapter";
import type {
  SourceAdapter,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * USGS earthquakes — the real-time GeoJSON summary feed.
 *
 * Terms (checked 2026-08-31):
 * Licence      US public domain; credit requested (rendered anyway).
 * Key          None.
 * Rate limit   None published. The feed sends `Cache-Control: max-age=60` and updates every
 *              minute, so TTL is 60s.
 *
 * Default feed `2.5_day` (M2.5+ in 24h). `all_hour` often looks empty. Override with
 * `USGS_QUAKE_FEED`.
 */

const FEED_BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

/** Allowlist of documented feeds, since the value goes into a server-side fetch URL. */
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

function selectedFeed(env: (name: string) => string | undefined): Feed {
  const requested = env("USGS_QUAKE_FEED")?.trim();
  return FEEDS.find((feed) => feed === requested) ?? DEFAULT_FEED;
}

/* ------------------------------------------------------------------ *
 * Upstream schema
 * ------------------------------------------------------------------ */

/**
 * `mag`, `place`, `alert` are nullable in real payloads. `metadata.generated` and `features`
 * are required so a wrong-shaped response doesn't parse as zero earthquakes. `.passthrough()`
 * tolerates added fields.
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

type UsgsPayload = z.infer<typeof usgsResponseSchema>;

/** Map an already-validated payload. `normaliseUsgs` wraps this for fixture tests. */
function mapUsgs(data: UsgsPayload, query: SourceQuery): readonly EarthquakeFeature[] {
  const features: EarthquakeFeature[] = [];
  for (const item of data.features) {
    const coordinates = item.geometry?.coordinates ?? [];
    const depth = coordinates[2];
    // No position, can't be drawn; drop here so the count is right.
    const position = coordinatePair(coordinates[0], coordinates[1]);
    if (!position) continue;

    const props = item.properties;
    const magnitude = typeof props.mag === "number" && Number.isFinite(props.mag) ? props.mag : null;

    const feature: EarthquakeFeature = {
      id: item.id,
      kind: "earthquakes",
      longitude: position.longitude,
      latitude: position.latitude,
      // Altitude is metres; depth is below the surface, so negative. km stays in `depthKm`.
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
    };

    // Feeds are global, so filter by viewport here.
    if (!withinBbox(feature, query)) continue;
    features.push(feature);
  }

  return applyLimit(features, query);
}

/** The upstream's own clock for the payload — never our receive time when one is offered. */
function observedAtFrom(data: UsgsPayload, receivedAt: Date): Date {
  const generated = new Date(data.metadata.generated);
  return Number.isNaN(generated.getTime()) ? receivedAt : generated;
}

/** Public mapper, for tests against a captured fixture. Validates, then maps. */
export const normaliseUsgs = normaliseVia(usgsResponseSchema, mapUsgs);

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const USGS_EARTHQUAKES_SLUG = "usgs-earthquakes";

export const usgsEarthquakes: SourceAdapter<EarthquakeFeature> = {
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
  /** A stale list is still true; it just lacks newer events. */
  staleWhileRevalidateSeconds: 900,
  responseSchema: usgsResponseSchema,
  normalise: normaliseUsgs,

  fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<EarthquakeFeature>> {
    return pollJson({
      slug: USGS_EARTHQUAKES_SLUG,
      url: `${FEED_BASE}/${selectedFeed(ctx.env)}.geojson`,
      ctx,
      schema: usgsResponseSchema,
      map: (data, receivedAt) => ({
        features: mapUsgs(data, query),
        observedAt: observedAtFrom(data, receivedAt),
      }),
    });
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(usgsEarthquakes, ctx);
  },
};
