import { fail, ok, type ToolResult } from "./result";

/**
 * NASA Global Imagery Browse Services (GIBS) — the satellite imagery comparator's catalogue,
 * URL templates and date arithmetic.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      NASA promotes full and open sharing of data. The GIBS documentation
 *              (https://nasa-gibs.github.io/gibs-api-docs/, read 2026-09-01) asks, under
 *              "Data Use Guidance and Acknowledgements", that users add an acknowledgement,
 *              and gives its exact wording — reproduced verbatim in `GIBS_ACKNOWLEDGEMENT`
 *              below and rendered on the map, at the point of display.
 * Key          None. No registration, no token, no referrer restriction.
 * Rate limit   No documented numeric limit. It is a tile service designed for slippy-map
 *              clients, and this tool is one: a browser requests the tiles for the viewport
 *              it is showing and nothing else. There is no server-side fetching and no
 *              prefetching, so our traffic is bounded by what a reader actually looks at.
 * Access ctrl  None. Public WMTS endpoint, documented, no auth.
 * Our path     THE BROWSER FETCHES THE TILES DIRECTLY. product-brief §2b: imagery is media,
 *              media is not proxied. The consequence, stated plainly on the tool page, is
 *              that NASA sees the reader's IP address and the area they are looking at — so
 *              the maps are click-to-load and the disclosure comes before the click.
 *
 * Every layer identifier, format, tile matrix set and date range below was read from
 * `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml` on
 * 2026-09-01, and representative tiles were fetched to confirm each one answers. Nothing
 * here is from memory.
 * ─────────────────────────────────────────────────────────────────────────────
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
  /**
   * The deepest zoom the service actually has tiles for. Beyond it a client is upsampling,
   * and a reader reading detail out of upsampled pixels is the single most common error this
   * kind of imagery produces.
   */
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
 * The imagery layers, all verified against the capabilities document on 2026-09-01.
 *
 * Two Terra/Aqua pairs and two VIIRS platforms are offered rather than one "satellite" layer,
 * because the choice of platform is an analytic decision and not a preference: Terra crosses
 * in the morning and Aqua in the early afternoon, so cloud that hides a site in one may have
 * cleared in the other on the same day. A tool that picked one for you would silently answer
 * "no imagery" for days on which imagery exists.
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
     * COVERAGE ENDS. The capabilities document's own dimension ran to 2023-07-07 on
     * 2026-09-01 and the layer's default date is that same day, so this product is no longer
     * being produced into GIBS. It ships anyway, with the end date stated, because
     * before-and-after night lights across 2016–2023 is a real and much-used technique for
     * observing power loss over a city. A layer whose coverage silently stopped, presented as
     * current, would be far worse than one that says where it stops.
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
 * Reference overlays, drawn on top of the imagery.
 *
 * These are what make the imagery readable: 306 m/pixel true colour with no coastline is
 * often an unidentifiable smear of brown and green. Both are GIBS-hosted, so the whole tool
 * contacts exactly one third-party origin.
 *
 * `Reference_Labels_15m` exists in the capabilities document but returned 404 for every tile
 * requested from the EPSG:3857 endpoint on 2026-09-01, at four zoom levels over three
 * continents. It is omitted rather than shipped as a layer that silently draws nothing.
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
 * The WMTS REST template, with Leaflet's placeholders.
 *
 * Shape confirmed against the capabilities document's own `ResourceURL` template and against
 * live tiles on 2026-09-01. WMTS orders the path `{TileMatrix}/{TileRow}/{TileCol}`, which
 * is `{z}/{y}/{x}` and NOT `{z}/{x}/{y}` — the transposed version returns tiles of a
 * different place rather than an error, so it is a mistake that renders as a plausible map
 * of somewhere else.
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

/**
 * Parse and validate a calendar date, rejecting the ones that look valid and are not.
 *
 * `new Date("2023-02-29")` rolls over to 1 March rather than failing, so a tool that trusted
 * it would silently request a different day than the reader asked for — and then report
 * whatever it found under the wrong date, which on a chronolocation tool is the whole
 * finding.
 */
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

/**
 * Is this layer's imagery available on this date?
 *
 * Refuses rather than clamps. A clamped date would render the nearest available day under
 * the label of the day the reader asked for, and the entire value of a before-and-after
 * comparison is that the two dates are the dates you believe they are.
 */
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
 * Ground distance one screen pixel covers at a given zoom, in metres, at a given latitude.
 *
 * Used to tell the reader, in the interface, when they have zoomed past the point where the
 * imagery carries any more information. Web Mercator: 156543.03392 m/px at zoom 0 on the
 * equator, halving each level, times cos(latitude).
 */
export function metresPerPixel(zoom: number, latitude: number): number {
  return (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}
