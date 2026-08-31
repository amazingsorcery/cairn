import { formatDdm, formatDecimal, formatDms, parseCoordinatePair } from "./angles";
import { decodePlusCode, encodePlusCode } from "./plus-codes";
import { fail, ok, type ToolResult } from "./result";
import { formatMgrs, fromMgrs, parseMgrs, toMgrs } from "./mgrs";
import { formatUtm, fromUtm, gridConvergence, parseUtm, toUtm } from "./utm";

/**
 * The facade the coordinate tool is built on: take a coordinate in whichever notation the
 * reader has, and render it in all of them.
 *
 * Everything here is a projection or a re-encoding of the same WGS 84 latitude and
 * longitude. None of it adds information. A ten-digit Plus Code derived from a coordinate
 * somebody read off a photograph is precise to 14 m and accurate to whatever the reading
 * was, which is usually much worse — the tool renders precision, and only the source can
 * supply accuracy.
 */

export const COORDINATE_FORMATS = [
  "decimalDegrees",
  "degreesMinutesSeconds",
  "degreesDecimalMinutes",
  "utm",
  "mgrs",
  "plusCode",
] as const;
export type CoordinateFormat = (typeof COORDINATE_FORMATS)[number];

export interface CoordinateRenderings {
  readonly latitude: number;
  readonly longitude: number;
  readonly decimalDegrees: string;
  readonly degreesMinutesSeconds: string;
  readonly degreesDecimalMinutes: string;
  /** `null` where the point is outside the format's defined area, with the reason alongside. */
  readonly utm: string | null;
  readonly utmError: string | null;
  readonly mgrs: string | null;
  readonly mgrsError: string | null;
  readonly plusCode: string | null;
  readonly plusCodeError: string | null;
  /** RFC 5870 `geo:` URI — what a phone hands to its map application. */
  readonly geoUri: string;
  /** Degrees between grid north and true north here. Relevant to any bearing off a grid map. */
  readonly gridConvergenceDegrees: number | null;
}

export function renderAllFormats(latitude: number, longitude: number): CoordinateRenderings {
  const utm = toUtm(latitude, longitude);
  const mgrs = toMgrs(latitude, longitude, 5);
  const plusCode = encodePlusCode(latitude, longitude, 11);

  return {
    latitude,
    longitude,
    decimalDegrees: `${formatDecimal(latitude)}, ${formatDecimal(longitude)}`,
    degreesMinutesSeconds: `${formatDms(latitude, "latitude")} ${formatDms(longitude, "longitude")}`,
    degreesDecimalMinutes: `${formatDdm(latitude, "latitude")} ${formatDdm(longitude, "longitude")}`,
    utm: utm.ok ? formatUtm(utm.value) : null,
    utmError: utm.ok ? null : utm.error,
    mgrs: mgrs.ok ? formatMgrs(mgrs.value) : null,
    mgrsError: mgrs.ok ? null : mgrs.error,
    plusCode: plusCode.ok ? plusCode.value : null,
    plusCodeError: plusCode.ok ? null : plusCode.error,
    geoUri: `geo:${formatDecimal(latitude)},${formatDecimal(longitude)}`,
    gridConvergenceDegrees: utm.ok ? gridConvergence(latitude, longitude) : null,
  };
}

export interface DetectedCoordinate {
  readonly latitude: number;
  readonly longitude: number;
  readonly detectedFormat: CoordinateFormat;
  /**
   * How large an area the input actually named, in metres. Zero for a point notation. An
   * MGRS reference at four digits or a six-digit Plus Code names a box, and rounding that
   * to a point silently invents precision.
   */
  readonly areaMetres: number;
}

const MGRS_PATTERN = /^\d{1,2}\s*[C-HJ-NP-X]\s*[A-HJ-NP-Z]\s*[A-HJ-NP-V]\s*(\d[\d\s]*)?$/i;
const UTM_PATTERN = /^\d{1,2}\s*[C-HJ-NP-X]\s*[, ]\s*\d/i;

/**
 * Work out which notation the reader pasted, then parse it.
 *
 * The order is deliberate. A Plus Code is unmistakable because of the separator. MGRS and
 * UTM both begin "number, letter" and are told apart by whether two 100 km square letters
 * follow. Everything else falls through to the latitude/longitude parser, which handles all
 * three angular notations itself.
 */
export function parseAnyCoordinate(input: string): ToolResult<DetectedCoordinate> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return fail("Enter a coordinate.");

  if (trimmed.includes("+")) {
    const decoded = decodePlusCode(trimmed);
    if (!decoded.ok) return fail(decoded.error);
    return ok({
      latitude: decoded.value.latitudeCentre,
      longitude: decoded.value.longitudeCentre,
      detectedFormat: "plusCode",
      areaMetres: Math.max(decoded.value.boxHeightMetres, decoded.value.boxWidthMetres),
    });
  }

  const compact = trimmed.replace(/\s+/g, " ");

  if (MGRS_PATTERN.test(compact)) {
    const reference = parseMgrs(compact);
    if (!reference.ok) return fail(reference.error);
    const point = fromMgrs(reference.value);
    if (!point.ok) return fail(point.error);
    return ok({
      latitude: point.value.latitude,
      longitude: point.value.longitude,
      detectedFormat: "mgrs",
      areaMetres: point.value.boxMetres,
    });
  }

  if (UTM_PATTERN.test(compact)) {
    const coordinate = parseUtm(compact);
    if (!coordinate.ok) return fail(coordinate.error);
    const point = fromUtm(coordinate.value);
    if (!point.ok) return fail(point.error);
    return ok({
      latitude: point.value.latitude,
      longitude: point.value.longitude,
      detectedFormat: "utm",
      areaMetres: 1,
    });
  }

  const pair = parseCoordinatePair(trimmed);
  if (!pair.ok) return fail(pair.error);
  return ok({
    latitude: pair.value.latitude,
    longitude: pair.value.longitude,
    detectedFormat: pair.value.notation,
    areaMetres: 0,
  });
}

export const COORDINATE_FORMAT_LABEL: Readonly<Record<CoordinateFormat, string>> = {
  decimalDegrees: "decimal degrees",
  degreesMinutesSeconds: "degrees, minutes and seconds",
  degreesDecimalMinutes: "degrees and decimal minutes",
  utm: "UTM",
  mgrs: "MGRS",
  plusCode: "Plus Code",
};
