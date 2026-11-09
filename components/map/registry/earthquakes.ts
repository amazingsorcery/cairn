import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, Rgba } from "./types";
import { instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Earthquakes (USGS). The reference example of the registry contract: nothing outside
 * `registry/` mentions earthquakes.
 *
 * Properties read from the adapter:
 *
 *   magnitude       number   Richter/moment magnitude as reported
 *   magnitudeType   string   "mb", "ml", "mww" — which scale the number is on
 *   place           string   the upstream's own place description
 *   depthKm         number   depth below the surface, kilometres, positive downwards
 *   occurredAt      string   ISO 8601, when the event happened (not when we fetched it)
 *   reviewStatus    string   "reviewed" | "automatic" — whether a human has checked it
 *   tsunamiFlagged  boolean  whether the event carried a tsunami flag
 *   alertLevel      string   PAGER level: green | yellow | orange | red. Null for most
 *   significance    number   the upstream's own composite significance score, 0–1000
 *
 * A missing or mistyped property renders as "not reported" (see `registry/props.ts`); it
 * never throws.
 */

/**
 * Dot radius in pixels from magnitude, so sizes stay readable at every zoom (metres would
 * make small quakes vanish and big ones cover countries). 4 px minimum for tap targets.
 */
function radiusForMagnitude(magnitude: number | null): number {
  if (magnitude === null) return 4;
  return Math.max(4, 3 + 2.2 * Math.max(0, magnitude));
}

/** `M 4.6` — one decimal, which is the precision the scale is reported to. */
function formatMagnitude(feature: SourceFeature): string | null {
  const magnitude = numberProp(feature, "magnitude");
  return magnitude === null ? null : `M ${magnitude.toFixed(1)}`;
}

/** `147.8 km` — one decimal. USGS reports depth to metres; the metre is noise here. */
function formatDepth(feature: SourceFeature): string | null {
  const depth = numberProp(feature, "depthKm");
  return depth === null ? null : `${depth.toFixed(1)} km`;
}

/**
 * `2026-08-31 09:19:57 UTC`. Absolute, so screenshots match; the layer's ticking age is in
 * the status row.
 */
function formatOccurredAt(feature: SourceFeature): string | null {
  const date = instantProp(feature, "occurredAt");
  if (!date) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(date)
    .replace(",", "")} UTC`;
}

/**
 * "reviewed by an analyst" / "automatic, not yet reviewed". Spelled out because automatic
 * solutions can shift by half a magnitude on review.
 */
function formatReviewStatus(feature: SourceFeature): string | null {
  const status = stringProp(feature, "reviewStatus");
  if (status === null) return null;
  if (status === "reviewed") return "reviewed by an analyst";
  if (status === "automatic") return "automatic, not yet reviewed";
  return status;
}

/**
 * The USGS tsunami flag marks ocean-region events where a tsunami could occur. It is not a
 * warning, and the wording says so.
 */
function formatTsunami(feature: SourceFeature): string | null {
  const value = feature.properties.tsunamiFlagged;
  if (typeof value !== "boolean") return null;
  return value
    ? "flagged by USGS as tsunami-relevant. This is not a tsunami warning."
    : "not flagged as tsunami-relevant";
}

/** PAGER alert level, labelled as an estimated impact rather than a severity. */
function formatAlertLevel(feature: SourceFeature): string | null {
  const level = stringProp(feature, "alertLevel");
  return level === null ? null : `PAGER ${level} (estimated impact)`;
}

const AMBER_300: Rgba = [242, 201, 122, 220];
const AMBER_650: Rgba = [133, 88, 12, 230];

export const earthquakesLayer: MapLayerDefinition = {
  id: "earthquakes",
  sourceSlug: "usgs-earthquakes",
  kind: "earthquakes",
  label: "Earthquakes",
  description:
    "Seismic events the United States Geological Survey has located and published, largest first.",
  defaultVisible: true,

  colour: {
    dark: AMBER_300,
    light: AMBER_650,
    token: "--amber-300 (dark) / --amber-650 (light)",
  },

  legend: {
    label: "Earthquakes",
    symbol: "graduated",
    note: "Larger dot means larger magnitude. Size is drawn in screen pixels, so it does not change with zoom.",
  },

  /** One `ScatterplotLayer` for all events, not DOM markers (the shared path handles 10,000 points). */
  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: true,
      filled: true,
      /* Screen-space sizing. See `radiusForMagnitude`. */
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      getRadius: (f) => radiusForMagnitude(numberProp(f, "magnitude")),
      getFillColor: input.colour,
      /*
       * Outline keeps translucent dots visible on any basemap; selection is a thicker ring,
       * not just a hue change.
       */
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1),
      /*
       * deck.gl caches accessor results; any accessor that closes over values outside `data`
       * (like `selectedId`) needs a trigger or the ring stays on the old selection.
       */
      updateTriggers: {
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
        getFillColor: [input.colour],
      },
      /* No radius transition under reduced motion. */
      transitions: input.reducedMotion ? {} : { getRadius: 150 },
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      key: "magnitude",
      label: "magnitude",
      numeric: true,
      rowHeader: true,
      initialDirection: "desc",
      value: (f) => numberProp(f, "magnitude"),
      format: formatMagnitude,
    },
    {
      key: "place",
      label: "place",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "place"),
    },
    {
      key: "depthKm",
      label: "depth (km)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => numberProp(f, "depthKm"),
      format: (f) => {
        const depth = numberProp(f, "depthKm");
        return depth === null ? null : depth.toFixed(1);
      },
    },
    {
      key: "occurredAt",
      label: "time (UTC)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => instantValue(f, "occurredAt"),
      format: formatOccurredAt,
    },
    {
      key: "reviewStatus",
      label: "review",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "reviewStatus"),
      format: formatReviewStatus,
    },
  ],

  detail: [
    { label: "Magnitude", value: formatMagnitude },
    {
      label: "Magnitude scale",
      value: (f) => stringProp(f, "magnitudeType"),
      mono: true,
    },
    { label: "Place", value: (f) => stringProp(f, "place") },
    { label: "Depth", value: formatDepth },
    { label: "Time", value: formatOccurredAt },
    { label: "Review status", value: formatReviewStatus },
    { label: "Tsunami flag", value: formatTsunami },
    { label: "Impact estimate", value: formatAlertLevel },
    {
      label: "Significance",
      value: (f) => {
        const value = numberProp(f, "significance");
        return value === null ? null : String(Math.round(value));
      },
    },
  ],

  defaultSort: { key: "magnitude", direction: "desc" },

  /* An empty feed is a real result, not "no results". */
  emptyMessage:
    "The survey answered and reported no earthquakes in this feed's window. That is a real result, not a failed query.",
  unavailableTitle: "Earthquakes unavailable",
};
