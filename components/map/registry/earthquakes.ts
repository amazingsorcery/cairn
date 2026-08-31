import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, Rgba } from "./types";
import { instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Earthquakes — the first layer, and the worked example of the registry contract.
 *
 * Everything specific to earthquakes is in this file. `components/map/map-surface.tsx`,
 * `deck-map.tsx`, `feature-table.tsx` and `feature-detail.tsx` contain the word "earthquake"
 * nowhere. If a second layer requires editing any of those, this abstraction has failed and
 * the fix belongs in `registry/types.ts`.
 *
 * ## The property names this file reads
 *
 * They are the contract between this layer and its adapter, and they are listed in
 * `docs/frontend/HANDOFF-map.md` §3 so the integrations engineer has one place to check:
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
 * A missing or wrongly-typed property renders as "not reported" in one cell (see
 * `registry/props.ts`). It never throws, because a table row is not the place to discover
 * that an upstream renamed a field.
 */

/**
 * Magnitude drives the dot's radius, in **pixels** rather than metres.
 *
 * Metres would be geographically honest and practically useless: an M2.5 would vanish at
 * world zoom and an M7 would cover a country at street zoom. The reader is scanning for
 * "where are the big ones", which is a screen-space question. `radiusUnits: "pixels"` in the
 * factory below is what makes this work at every zoom.
 *
 * The floor of 4 px is a hit-target floor as much as a visual one: below it the dot is
 * hard to tap on a phone, and this map has to be usable one-handed.
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
 * `2026-08-31 09:19:57 UTC`.
 *
 * Absolute and in UTC, never "3 hours ago" on its own. An audience that corroborates each
 * other's screenshots needs the same string on two screens, and a relative time is the one
 * number that differs between them. The layer's own age is shown separately, once, in the
 * status row — that is the number ADR 0014 makes tick.
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
 * "reviewed by an analyst" / "automatic, not yet reviewed".
 *
 * The raw value is a single word that looks like metadata and is actually a confidence
 * statement: an automatic solution can move by half a magnitude when a human looks at it.
 * A reader deciding whether to publish a number needs that spelled out, not decoded.
 */
function formatReviewStatus(feature: SourceFeature): string | null {
  const status = stringProp(feature, "reviewStatus");
  if (status === null) return null;
  if (status === "reviewed") return "reviewed by an analyst";
  if (status === "automatic") return "automatic, not yet reviewed";
  return status;
}

/**
 * The tsunami flag is NOT a tsunami warning, and the wording has to say so.
 *
 * USGS sets it for events in ocean regions where a tsunami *could* be generated. Rendering it
 * as "tsunami: yes" would put a warning on this map that no warning centre issued — the exact
 * failure mode of a safety layer that paraphrases its source.
 */
function formatTsunami(feature: SourceFeature): string | null {
  const value = feature.properties.tsunamiFlagged;
  if (typeof value !== "boolean") return null;
  return value
    ? "flagged by USGS as tsunami-relevant. This is not a tsunami warning."
    : "not flagged as tsunami-relevant";
}

/**
 * PAGER alert level, spelled out. The raw value is one colour word and reads as decoration
 * until you know it is a shaking-impact estimate rather than a severity badge.
 */
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

  /**
   * One `ScatterplotLayer` for every event. Not a marker per event: a DOM marker per feature
   * is what caps a map at a few hundred points, and this layer shares its code path with the
   * aircraft layer, which has to hold 10,000 (`docs/frontend/HANDOFF-map.md` §5).
   */
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
       * The outline is not decoration. A translucent amber dot over a pale basemap and the
       * same dot over a dark one need a boundary to stay a dot, and the selected feature
       * needs to be distinguishable from its neighbours by something other than hue —
       * colour is never the only signal (`docs/brand/HANDOFF.md` §3). Selection is a
       * thicker, lighter ring, and it is also announced in the detail panel's heading.
       */
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1),
      /*
       * WITHOUT THESE THE MAP LIES. deck.gl caches accessor output per layer instance and
       * will not re-evaluate `getLineColor` or `getLineWidth` just because `selectedId`
       * changed — the ring would stay on the previously selected dot. Every accessor that
       * closes over something outside `data` needs its trigger listed.
       */
      updateTriggers: {
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
        getFillColor: [input.colour],
      },
      /*
       * No radius transition when the reader has asked for reduced motion. deck.gl's
       * `transitions` interpolate over frames, which is continuous motion by another name.
       */
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

  /*
   * NOT "no results". An empty earthquake layer is a fact about the world in a time window,
   * and saying so is different from saying a filter matched nothing.
   */
  emptyMessage:
    "The survey answered and reported no earthquakes in this feed's window. That is a real result, not a failed query.",
  unavailableTitle: "Earthquakes unavailable",
};
