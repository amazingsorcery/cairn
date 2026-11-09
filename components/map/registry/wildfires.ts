import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Satellite fire detections from NASA FIRMS.
 *
 * - A detection is a thermal anomaly, not a confirmed wildfire (flares, industry and
 *   agricultural burning register too), hence "Fire detections".
 * - A detection is a pixel (VIIRS ~375 m, MODIS ~1 km), so every feature gets `precision`.
 *
 * The response shape is unverified: there's no captured fixture (a FIRMS MAP_KEY needs an
 * account), so the column names come from NASA's documentation. The parser reads by column
 * name and needs only the four columns every product has, so a shape change becomes
 * `schemaChanged`. Without `FIRMS_MAP_KEY` the layer shows `notConfigured`.
 *
 * Properties read (from `lib/sources/nasa-firms.ts`):
 *
 *   detectedAt    string   ISO 8601, from the satellite's acquisition date and UTC time
 *   frpMw         number   fire radiative power, megawatts
 *   brightnessK   number   brightness temperature, kelvin
 *   confidence    string   VIIRS l/n/h or MODIS 0–100, PASSED THROUGH UNNORMALISED
 *   satellite     string   the platform, e.g. N (Suomi NPP)
 *   instrument    string   VIIRS or MODIS
 *   night         boolean  detected on the night side, which reduces false positives
 */

/** --clay-400 #CA6939 and --clay-600 #B94B14, per `app/tokens.css`. */
const CLAY_400: Rgba = [202, 105, 57, 225];
const CLAY_600: Rgba = [185, 75, 20, 235];

const NUMBER = new Intl.NumberFormat("en-GB");

/** Documented pixel widths in metres. Unknown instruments get the caveat without a size. */
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
 * Upstream confidence with its scale named (VIIRS letters, MODIS 0–100). Not normalised,
 * since the scales aren't comparable.
 */
function formatConfidence(feature: SourceFeature): string | null {
  const raw = stringProp(feature, "confidence");
  if (raw === null) return null;
  const instrument = instrumentOf(feature);
  if (instrument === "VIIRS") return `${raw} (VIIRS letter scale, unaltered)`;
  if (instrument === "MODIS") return `${raw} (MODIS 0–100 scale, unaltered)`;
  return `${raw} (the source's own scale, unaltered)`;
}

/** Day or night. Night detections are much less likely to be sun-glint false positives. */
function formatDayNight(feature: SourceFeature): string | null {
  const night = boolProp(feature, "night");
  if (night === null) return null;
  return night ? "night" : "day";
}

/** Pixel caveat; applies to every detection. */
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
 * Radius from fire radiative power on a square-root scale (FRP spans orders of magnitude).
 * Clamped to 4–18 px.
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
      /* No transitions: interpolating between passes would show a fire moving. */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      /* Row header is acquisition time: detections have no name, and time is always present. */
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
      /* Sorted as text: VIIRS letters and MODIS numbers have no shared order. */
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
