import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Satellite fire detections, from NASA FIRMS.
 *
 * ## Two things this layer must never let a reader assume
 *
 * 1. **A detection is not a confirmed wildfire.** FIRMS reports thermal anomalies. Gas
 *    flares, steel works, agricultural burning and volcanic activity all register, and the
 *    product documentation says so. The layer is called *fire detections* rather than
 *    *wildfires* for that reason, and the description says it in words rather than relying on
 *    the name.
 * 2. **A detection is a pixel, not a point.** VIIRS pixels are about 375 m across and MODIS
 *    pixels about a kilometre. The coordinate is the centre of that cell, and the fire is
 *    somewhere inside it — which is what `precision` says, on every feature, because unlike
 *    the weather layer this is uniformly true here rather than true of 98.7% of the rows.
 *
 * ## ⚠ The response shape behind this layer is UNVERIFIED
 *
 * `lib/sources/nasa-firms.ts` and `docs/sources/nasa-firms.md` both carry this warning and it
 * is repeated here because this file is what a reader actually sees. Obtaining a FIRMS
 * MAP_KEY requires registering an account, which the agent that wrote the adapter could not
 * do, so **there is no captured fixture**: the column names come from NASA's product
 * documentation rather than from a response anyone has held. The parser reads columns by name
 * and requires only the four every FIRMS product carries, so a shape change degrades to
 * `schemaChanged` rather than to "no fires anywhere on earth" — but defensive is not verified,
 * and the layer's description says so where an operator or a reader will meet it.
 *
 * Without `FIRMS_MAP_KEY` the adapter returns `notConfigured` and this layer renders that
 * state alone, naming the missing variable. Nothing else on the map is affected.
 *
 * ## The property names this file reads
 *
 * From `lib/sources/nasa-firms.ts`, and listed in `docs/frontend/HANDOFF-map.md` §3:
 *
 *   detectedAt    string   ISO 8601, from the satellite's acquisition date and UTC time
 *   frpMw         number   fire radiative power, megawatts
 *   brightnessK   number   brightness temperature, kelvin
 *   confidence    string   VIIRS l/n/h or MODIS 0–100, PASSED THROUGH UNNORMALISED
 *   satellite     string   the platform, e.g. N (Suomi NPP)
 *   instrument    string   VIIRS or MODIS
 *   night         boolean  detected on the night side, which reduces false positives
 */

/** --clay-400 #CA6939 and --clay-600 #B94B14, per `app/tokens.css` §1. */
const CLAY_400: Rgba = [202, 105, 57, 225];
const CLAY_600: Rgba = [185, 75, 20, 235];

const NUMBER = new Intl.NumberFormat("en-GB");

/**
 * Pixel footprints, in metres across, as the instruments' own documented resolutions.
 *
 * These are the two numbers `lib/sources/nasa-firms.ts` records for the products it may
 * select: VIIRS at 375 m — the resolution FIRMS leads with and the adapter's default product
 * — and MODIS at 1 km. An unrecognised instrument gets the caveat without a number rather
 * than a guessed one.
 */
const PIXEL_METRES: Readonly<Record<string, number>> = { VIIRS: 375, MODIS: 1000 };

function instrumentOf(feature: SourceFeature): string | null {
  return stringProp(feature, "instrument")?.trim().toUpperCase() ?? null;
}

/** `31/08/2026 13:22 UTC`. Absolute and in UTC, for the reason given in `earthquakes.ts`. */
function formatDetectedAt(feature: SourceFeature): string | null {
  const date = instantProp(feature, "detectedAt");
  if (!date) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(date)
    .replace(",", "")} UTC`;
}

function formatPower(feature: SourceFeature): string | null {
  const frp = numberProp(feature, "frpMw");
  return frp === null ? null : `${NUMBER.format(Number(frp.toFixed(1)))} MW`;
}

function formatBrightness(feature: SourceFeature): string | null {
  const kelvin = numberProp(feature, "brightnessK");
  return kelvin === null ? null : `${NUMBER.format(Number(kelvin.toFixed(1)))} K`;
}

/**
 * The upstream's confidence, with the scale it is on and nothing else added.
 *
 * VIIRS reports a letter and MODIS a 0–100 integer. They do not mean the same thing, so the
 * adapter passes the value through unnormalised and this says which scale the reader is
 * looking at rather than translating one into the other. Flattening them would invent a
 * precision the data does not have — the adapter's own words, and the reason this column
 * sorts as text.
 */
function formatConfidence(feature: SourceFeature): string | null {
  const raw = stringProp(feature, "confidence");
  if (raw === null) return null;
  const instrument = instrumentOf(feature);
  if (instrument === "VIIRS") return `${raw} (VIIRS letter scale, unaltered)`;
  if (instrument === "MODIS") return `${raw} (MODIS 0–100 scale, unaltered)`;
  return `${raw} (the source's own scale, unaltered)`;
}

/**
 * Day or night, in words rather than as the upstream's `D`/`N`.
 *
 * It is carried because it is analytically load-bearing: NASA's own documentation, and the
 * adapter's recorded reason for keeping the field, is that a night detection is far less
 * likely to be a sun-glint false positive. The detail panel says that; the column says which.
 */
function formatDayNight(feature: SourceFeature): string | null {
  const night = boolProp(feature, "night");
  if (night === null) return null;
  return night ? "night" : "day";
}

/**
 * THE PIXEL CAVEAT, ON EVERY FEATURE.
 *
 * Unlike the weather layer, where the caveat separates 98.7% of alerts from the 1.3% that
 * carry real geometry, every FIRMS detection is a cell rather than a location. Setting it on
 * all of them is therefore not "caveating everything": it is one true statement about one
 * instrument, and the layer that could honestly return null here is a different layer.
 */
function firmsPrecision(feature: SourceFeature): FeaturePrecision {
  const instrument = instrumentOf(feature);
  const across = instrument === null ? undefined : PIXEL_METRES[instrument];

  if (across === undefined) {
    return {
      label: "satellite pixel",
      note:
        "This is the centre of the satellite pixel the heat was detected in, not the position " +
        "of a fire. The instrument was not reported, so the size of that pixel is not stated " +
        "here — check the product against NASA FIRMS before treating the coordinate as a place.",
    };
  }

  return {
    label: "satellite pixel",
    note:
      `This is the centre of the ${instrument} pixel the heat was detected in — about ` +
      `${NUMBER.format(across)} m across — not the position of a fire. The source of the heat ` +
      `is somewhere in that cell, and it may be far smaller than the cell or much larger than ` +
      `it. A detection is a thermal anomaly rather than a confirmed wildfire.`,
    approximateRadiusMetres: Math.round(across / 2),
  };
}

/**
 * Dot size is fire radiative power, on a square-root scale.
 *
 * FRP spans several orders of magnitude — a smouldering field and a firestorm are in the same
 * feed — so a linear radius would render everything below the top percentile as the same
 * minimum dot. The square root compresses that without inverting any ordering. The floor of 4
 * px is the hit-target floor used across this map; the ceiling stops one detection covering a
 * region at low zoom.
 */
function radiusForPower(frp: number | null): number {
  if (frp === null) return 4;
  return Math.min(18, Math.max(4, 3 + 1.6 * Math.sqrt(Math.max(0, frp))));
}

export const wildfiresLayer: MapLayerDefinition = {
  id: "wildfires",
  sourceSlug: "nasa-firms",
  kind: "wildfires",
  label: "Fire detections",
  description:
    "Thermal anomalies detected by satellite and published by NASA FIRMS for the last 24 hours. A detection is not a confirmed wildfire — flares, industrial heat and agricultural burning register too — and this layer's parser was written from NASA's documentation rather than from a captured response, so read it with that in mind.",
  defaultVisible: false,

  colour: { dark: CLAY_400, light: CLAY_600, token: "--clay-400 / --clay-600" },

  legend: {
    label: "Fire detections",
    symbol: "graduated",
    note: "Larger dot means higher fire radiative power — how much heat the pixel was emitting, which is not the same as how large the fire is.",
  },

  precision: firmsPrecision,

  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      getRadius: (f) => radiusForPower(numberProp(f, "frpMw")),
      getFillColor: input.colour,
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /*
       * Nothing moves. A detection is a satellite pass at an instant: it appears, and it is
       * either detected again on the next pass or it is not. Interpolating between two of them
       * would draw a fire travelling, which is not what happened.
       */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      /*
       * The row header is the acquisition time, because a FIRMS detection has no name and no
       * place: the two things that identify it are when the satellite saw it and where. Time
       * is derived from `acq_date` and `acq_time`, the two columns every FIRMS product is
       * documented to carry, so it is the field least likely to be absent.
       */
      key: "detectedAt",
      label: "detected (UTC)",
      numeric: true,
      rowHeader: true,
      initialDirection: "desc",
      value: (f) => instantValue(f, "detectedAt"),
      format: formatDetectedAt,
    },
    {
      key: "frpMw",
      label: "power (MW)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => numberProp(f, "frpMw"),
      format: (f) => {
        const frp = numberProp(f, "frpMw");
        return frp === null ? null : NUMBER.format(Number(frp.toFixed(1)));
      },
    },
    {
      key: "brightnessK",
      label: "brightness (K)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => numberProp(f, "brightnessK"),
      format: (f) => {
        const kelvin = numberProp(f, "brightnessK");
        return kelvin === null ? null : NUMBER.format(Number(kelvin.toFixed(1)));
      },
    },
    {
      /*
       * Sorted as text, deliberately. VIIRS letters and MODIS integers are different scales,
       * and inventing an order across them — or asserting what `l`, `n` and `h` rank as —
       * would be this map claiming to know something the source did not say.
       */
      key: "confidence",
      label: "confidence",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "confidence"),
      format: formatConfidence,
    },
    {
      key: "night",
      label: "day / night",
      numeric: false,
      initialDirection: "asc",
      value: formatDayNight,
    },
  ],

  detail: [
    { label: "Detected", value: formatDetectedAt },
    { label: "Fire radiative power", value: formatPower },
    { label: "Brightness temperature", value: formatBrightness },
    { label: "Confidence", value: formatConfidence },
    {
      label: "Lighting",
      value: (f) => {
        const night = boolProp(f, "night");
        if (night === null) return null;
        return night
          ? "detected on the night side, which makes a sun-glint false positive far less likely"
          : "detected in daylight, where sun glint is a documented source of false positives";
      },
    },
    { label: "Instrument", value: (f) => stringProp(f, "instrument"), mono: true },
    { label: "Satellite", value: (f) => stringProp(f, "satellite"), mono: true },
  ],

  defaultSort: { key: "frpMw", direction: "desc" },

  emptyMessage:
    "NASA FIRMS answered and reported no detections in the last day. A worldwide day with no thermal anomalies at all is unusual enough to be worth checking against the FIRMS map before relying on it.",
  unavailableTitle: "Fire detections unavailable",
};
