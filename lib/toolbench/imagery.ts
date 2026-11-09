import { fail, ok, type ToolResult } from "./result";

/**
 * NASA GIBS: the imagery comparator's layer catalogue, URL templates and date arithmetic.
 *
 * Terms (checked 2026-09-01, https://nasa-gibs.github.io/gibs-api-docs/):
 *   Licence      Open data; GIBS asks for the acknowledgement in `GIBS_ACKNOWLEDGEMENT`,
 *                shown on the map.
 *   Key          None.
 *   Rate limit   None documented; the browser only fetches tiles for the visible viewport.
 *   Our path     The browser fetches tiles directly (media isn't proxied), so NASA sees the
 *                reader's IP and area. Maps are click-to-load behind a disclosure.
 *
 * Layer ids, formats, matrix sets and date ranges are from the WMTSCapabilities.xml at
 * `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/` (2026-09-01).
 */

/** The one origin this tool contacts. Needs `img-src` in the deployed CSP. */
export const GIBS_ORIGIN = "https://gibs.earthdata.nasa.gov";

/** The EPSG:3857 (Web Mercator) REST endpoint, which is what a slippy map needs. */
export const GIBS_ENDPOINT = `${GIBS_ORIGIN}/wmts/epsg3857/best`;

/** The exact wording GIBS asks for. Rendered on the map, not in a footer. */
export const GIBS_ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse " +
  "Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).";

export const GIBS_DOCS_URL = "https://nasa-gibs.github.io/gibs-api-docs/";

export type TileFormat = "jpg" | "png";

export interface ImageryLayer {
  /** The WMTS layer identifier, verbatim from the capabilities document. */
  readonly id: string;
  readonly label: string;
  /** Satellite and instrument, because the overpass time is a property of the platform. */
  readonly platform: string;
  readonly tileMatrixSet: string;
  readonly format: TileFormat;
  /** Deepest zoom with real tiles; beyond it the client upsamples. */
  readonly maxNativeZoom: number;
  /** Metres per pixel at `maxNativeZoom`, from the tile matrix's own scale denominator. */
  readonly metresPerPixel: number;
  /** First date with coverage, `YYYY-MM-DD`. */
  readonly earliest: string;
  /** Last date with coverage. Null means "up to today". */
  readonly latest: string | null;
  /** What this band combination is for, in an investigator's terms. */
  readonly whatItShows: string;
  /** When the platform passes overhead, which decides what the light looks like. */
  readonly overpassNote: string;
}

/**
 * Imagery layers (verified 2026-09-01). Several platforms are offered because overpass times
 * differ: Terra is morning, Aqua early afternoon, so cloud in one may be clear in the other.
 */
export const IMAGERY_LAYERS: readonly ImageryLayer[] = [
  {
    id: "MODIS_Terra_CorrectedReflectance_TrueColor",
    label: "True colour — MODIS, Terra",
    platform: "Terra (MODIS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2000-02-24",
    latest: null,
    whatItShows:
      "What the eye would see. Cloud, snow, smoke plumes, flood water, large burn scars and dust.",
    overpassNote: "Descending morning orbit, crossing the equator at about 10:30 local solar time.",
  },
  {
    id: "MODIS_Aqua_CorrectedReflectance_TrueColor",
    label: "True colour — MODIS, Aqua",
    platform: "Aqua (MODIS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2002-07-03",
    latest: null,
    whatItShows:
      "The same as Terra, three hours later in the day. Worth checking when Terra's pass is under cloud.",
    overpassNote: "Ascending afternoon orbit, crossing the equator at about 13:30 local solar time.",
  },
  {
    id: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    label: "True colour — VIIRS, Suomi NPP",
    platform: "Suomi NPP (VIIRS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2015-11-24",
    latest: null,
    whatItShows:
      "A newer instrument with wider swaths and fewer gaps between passes than MODIS at mid-latitudes.",
    overpassNote: "Afternoon orbit, crossing the equator at about 13:30 local solar time.",
  },
  {
    id: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    label: "True colour — VIIRS, NOAA-20",
    platform: "NOAA-20 (VIIRS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2018-01-05",
    latest: null,
    whatItShows:
      "A second VIIRS, half an orbit from Suomi NPP, so between them a place is seen twice each afternoon.",
    overpassNote: "Afternoon orbit, about 50 minutes offset from Suomi NPP.",
  },
  {
    id: "MODIS_Terra_CorrectedReflectance_Bands721",
    label: "Bands 7-2-1 (burn scars) — MODIS, Terra",
    platform: "Terra (MODIS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2000-02-24",
    latest: null,
    whatItShows:
      "Shortwave infrared in place of red. Burned ground turns brick red, active fire is bright red-orange, vegetation is green and smoke becomes near-transparent — so a fire's footprint is visible through its own plume, which true colour cannot do.",
    overpassNote: "Descending morning orbit, crossing the equator at about 10:30 local solar time.",
  },
  {
    id: "MODIS_Aqua_CorrectedReflectance_Bands721",
    label: "Bands 7-2-1 (burn scars) — MODIS, Aqua",
    platform: "Aqua (MODIS)",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxNativeZoom: 9,
    metresPerPixel: 306,
    earliest: "2002-07-03",
    latest: null,
    whatItShows: "The same shortwave-infrared combination on the afternoon pass.",
    overpassNote: "Ascending afternoon orbit, crossing the equator at about 13:30 local solar time.",
  },
  {
    id: "VIIRS_SNPP_DayNightBand_ENCC",
    label: "Night lights — VIIRS Day/Night Band",
    platform: "Suomi NPP (VIIRS DNB)",
    tileMatrixSet: "GoogleMapsCompatible_Level8",
    format: "png",
    maxNativeZoom: 8,
    metresPerPixel: 611,
    earliest: "2016-11-30",
    /**
     * Coverage ends 2023-07-07 (no longer produced into GIBS). Kept, with the end date shown,
     * for before/after night-light comparisons.
     */
    latest: "2023-07-07",
    whatItShows:
      "Emitted light at night: city lighting, gas flares, lit fishing fleets. A city that goes dark between two dates is visible here and nowhere else in this list.",
    overpassNote: "Night pass, about 01:30 local solar time. Moonlight strongly affects the image.",
  },
];

export function findImageryLayer(id: string): ImageryLayer | null {
  return IMAGERY_LAYERS.find((layer) => layer.id === id) ?? null;
}

/**
 * Reference overlays drawn over the imagery, GIBS-hosted so the tool contacts one origin.
 * `Reference_Labels_15m` is omitted: it 404s on the EPSG:3857 endpoint (checked 2026-09-01).
 */
export interface ReferenceLayer {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tileMatrixSet: string;
  readonly maxNativeZoom: number;
}

export const REFERENCE_LAYERS: readonly ReferenceLayer[] = [
  {
    id: "Coastlines_15m",
    label: "Coastlines",
    description: "Shorelines and large lakes, from OpenStreetMap at 15 m.",
    tileMatrixSet: "GoogleMapsCompatible_Level13",
    maxNativeZoom: 13,
  },
  {
    id: "Reference_Features_15m",
    label: "Borders, roads and rivers",
    description: "Administrative boundaries, major roads and rivers, from OpenStreetMap at 15 m.",
    tileMatrixSet: "GoogleMapsCompatible_Level13",
    maxNativeZoom: 13,
  },
];

/* ------------------------------------------------------------------ *
 * URL templates
 * ------------------------------------------------------------------ */

/**
 * WMTS REST template with Leaflet placeholders. WMTS order is `{z}/{y}/{x}`, not `{z}/{x}/{y}`;
 * transposing silently shows a different place.
 */
export function imageryTileTemplate(layer: ImageryLayer, isoDate: string): string {
  return (
    `${GIBS_ENDPOINT}/${layer.id}/default/${isoDate}/${layer.tileMatrixSet}` +
    `/{z}/{y}/{x}.${layer.format}`
  );
}

/** Reference layers carry no time dimension, so the date segment is absent entirely. */
export function referenceTileTemplate(layer: ReferenceLayer): string {
  return `${GIBS_ENDPOINT}/${layer.id}/default/${layer.tileMatrixSet}/{z}/{y}/{x}.png`;
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` in UTC. GIBS dates are UTC days, not local ones. */
export function toIsoDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Parse a calendar date strictly; `new Date("2023-02-29")` would roll over to 1 March. */
export function parseIsoDate(text: string): ToolResult<string> {
  const match = ISO_DATE.exec(text.trim());
  if (!match) return fail("Dates are YYYY-MM-DD.");

  const [, yearText, monthText, dayText] = match as unknown as [string, string, string, string];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return fail(`${text} is not a real date.`);
  }
  return ok(toIsoDate(candidate));
}

/** Move a date by whole days, correctly across month, year and leap boundaries. */
export function shiftIsoDate(isoDate: string, days: number): ToolResult<string> {
  const parsed = parseIsoDate(isoDate);
  if (!parsed.ok) return parsed;
  const instant = new Date(`${parsed.value}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return ok(toIsoDate(instant));
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): ToolResult<number> {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a.ok) return a;
  if (!b.ok) return b;
  const millis =
    new Date(`${b.value}T00:00:00Z`).getTime() - new Date(`${a.value}T00:00:00Z`).getTime();
  return ok(Math.round(millis / 86_400_000));
}

export interface CoverageCheck {
  readonly isoDate: string;
  /** Null when the date is inside coverage. */
  readonly problem: string | null;
}

/** Is imagery available on this date? Refuses rather than clamping to the nearest day. */
export function checkCoverage(layer: ImageryLayer, isoDate: string, today: string): CoverageCheck {
  const parsed = parseIsoDate(isoDate);
  if (!parsed.ok) return { isoDate, problem: parsed.error };

  if (parsed.value < layer.earliest) {
    return {
      isoDate: parsed.value,
      problem: `${layer.platform} has no coverage before ${layer.earliest}. Choose a later date, or a different platform — the list is ordered by launch.`,
    };
  }

  const latest = layer.latest ?? today;
  if (parsed.value > latest) {
    return {
      isoDate: parsed.value,
      problem:
        layer.latest === null
          ? `That date is in the future. The most recent imagery is ${today}, and the current day's tiles are often incomplete until the passes are processed.`
          : `This layer's coverage ends on ${layer.latest}; it is no longer being produced. Nothing after that date exists to show.`,
    };
  }

  return { isoDate: parsed.value, problem: null };
}

/**
 * Metres per screen pixel at a zoom and latitude (Web Mercator: 156543.03392 m/px at z0 on the
 * equator, halving per level, times cos(lat)). Used to warn when zoomed past native detail.
 */
export function metresPerPixel(zoom: number, latitude: number): number {
  return (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}
