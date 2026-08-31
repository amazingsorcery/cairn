import { fail, ok, type ToolResult } from "./result";

/**
 * Universal Transverse Mercator, from the series in J. P. Snyder, *Map Projections — A
 * Working Manual*, USGS Professional Paper 1395 (1987), equations 8-5 to 8-12.
 *
 * The series is truncated at the sixth order, which is accurate to a few millimetres within
 * the 6-degree zone a UTM coordinate is defined in. That is far below the precision of any
 * source an investigator will be converting from, and it is not adequate for geodesy.
 *
 * Two properties of UTM matter more for reading a coordinate than the arithmetic does:
 *
 *   - **A UTM coordinate is meaningless without its zone and hemisphere.** "630084 4833438"
 *     names one point per zone and there are sixty zones. Grid north is not true north
 *     either: it differs from it by the convergence angle, up to about 3 degrees at a zone edge.
 *   - **A UTM coordinate is meaningless without its datum.** The same ground point is a few
 *     hundred metres apart in WGS 84 and in a mid-century national datum. Where the source
 *     does not state a datum, the conversion is a hypothesis.
 */

export interface Ellipsoid {
  readonly name: string;
  /** Semi-major axis, metres. */
  readonly a: number;
  /** First eccentricity squared. */
  readonly eSquared: number;
}

export const WGS84: Ellipsoid = {
  name: "WGS 84",
  a: 6_378_137,
  // Derived from the defining flattening 1/298.257223563 rather than typed as a decimal,
  // so the value cannot drift from the definition it is supposed to represent.
  eSquared: 2 / 298.257223563 - 1 / (298.257223563 * 298.257223563),
};

/**
 * Present only so the implementation can be checked against Snyder's own worked example,
 * which predates WGS 84. Not offered in the UI.
 */
export const CLARKE_1866: Ellipsoid = {
  name: "Clarke 1866",
  a: 6_378_206.4,
  eSquared: 0.00676866,
};

/** UTM's scale factor on the central meridian. Fixed by the projection's definition. */
export const UTM_SCALE_FACTOR = 0.9996;
const FALSE_EASTING = 500_000;
const FALSE_NORTHING_SOUTH = 10_000_000;

export interface UtmCoordinate {
  readonly zone: number;
  /** MGRS latitude band letter, C to X omitting I and O. Carries the hemisphere. */
  readonly band: string;
  readonly hemisphere: "N" | "S";
  readonly easting: number;
  readonly northing: number;
}

const BAND_LETTERS = "CDEFGHJKLMNPQRSTUVWX";

/**
 * The latitude band letter for a latitude. Bands are 8 degrees each from -80, except X,
 * which is 12 degrees (72 to 84) so that the scheme reaches the top of the UTM area.
 *
 * The band letters run C to X omitting I and O, which are omitted throughout the military
 * grid because they are too easily read as 1 and 0 in a handwritten or radioed coordinate.
 */
export function latitudeBand(latitude: number): ToolResult<string> {
  if (latitude < -80 || latitude > 84) {
    return fail(
      `UTM is defined between 80S and 84N; ${latitude.toFixed(4)} is outside it. Polar coordinates use the UPS grid, which this tool does not implement.`,
    );
  }
  if (latitude >= 72) return ok("X");
  const letter = BAND_LETTERS[Math.floor((latitude + 80) / 8)];
  return letter === undefined ? fail("Latitude outside the UTM band scheme.") : ok(letter);
}

/**
 * Zone number, including the two published irregularities.
 *
 * Zone 32 is widened westward between 56N and 64N so that south-west Norway is not split,
 * and the Svalbard zones 31, 33, 35 and 37 are widened to 12 degrees with 32, 34 and 36
 * removed. These are part of the grid's definition, not local custom: computing the zone
 * with the naive formula puts a Norwegian coordinate in the wrong zone, and the result is
 * hundreds of kilometres out.
 */
export function utmZone(latitude: number, longitude: number): number {
  const normalisedLon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  let zone = Math.floor((normalisedLon + 180) / 6) + 1;

  if (latitude >= 56 && latitude < 64 && normalisedLon >= 3 && normalisedLon < 12) {
    zone = 32;
  }
  if (latitude >= 72 && latitude < 84) {
    if (normalisedLon >= 0 && normalisedLon < 9) zone = 31;
    else if (normalisedLon >= 9 && normalisedLon < 21) zone = 33;
    else if (normalisedLon >= 21 && normalisedLon < 33) zone = 35;
    else if (normalisedLon >= 33 && normalisedLon < 42) zone = 37;
  }
  return zone;
}

/** Central meridian of a zone, in degrees. */
export function centralMeridian(zone: number): number {
  return (zone - 1) * 6 - 180 + 3;
}

const RAD = Math.PI / 180;

/** Meridional arc: distance along the meridian from the equator to latitude phi. Snyder 3-21. */
function meridionalArc(phi: number, ellipsoid: Ellipsoid): number {
  const { a, eSquared: e2 } = ellipsoid;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

export interface TransverseMercatorOptions {
  readonly ellipsoid?: Ellipsoid;
  readonly scaleFactor?: number;
  /** Degrees. Defaults to the UTM central meridian for the computed zone. */
  readonly centralMeridianDegrees?: number;
  readonly falseEasting?: number;
  readonly falseNorthing?: number;
}

/**
 * Transverse Mercator forward, without the UTM false origins applied. Exposed separately so
 * the implementation can be tested against Snyder's numerical example, which is stated in
 * these raw projected coordinates.
 */
export function transverseMercatorForward(
  latitude: number,
  longitude: number,
  centralMeridianDegrees: number,
  ellipsoid: Ellipsoid = WGS84,
  scaleFactor: number = UTM_SCALE_FACTOR,
): { x: number; y: number } {
  const { a, eSquared: e2 } = ellipsoid;
  const ePrime2 = e2 / (1 - e2);

  const phi = latitude * RAD;
  // Wrap the longitude difference into (-180, 180] so a point just east of the antimeridian
  // does not produce a 350-degree offset and a nonsense easting.
  const dLonDeg = (((longitude - centralMeridianDegrees + 540) % 360) - 180 + 360) % 360;
  const lambdaDiff = (dLonDeg > 180 ? dLonDeg - 360 : dLonDeg) * RAD;

  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);

  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = ePrime2 * cosPhi * cosPhi;
  const A = lambdaDiff * cosPhi;
  const M = meridionalArc(phi, ellipsoid);

  const A2 = A * A;
  const A3 = A2 * A;
  const A4 = A3 * A;
  const A5 = A4 * A;
  const A6 = A5 * A;

  const x =
    scaleFactor *
    N *
    (A + ((1 - T + C) * A3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ePrime2) * A5) / 120);

  const y =
    scaleFactor *
    (M +
      N *
        tanPhi *
        (A2 / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ePrime2) * A6) / 720));

  return { x, y };
}

/** WGS 84 latitude and longitude to a UTM coordinate. */
export function toUtm(
  latitude: number,
  longitude: number,
  ellipsoid: Ellipsoid = WGS84,
): ToolResult<UtmCoordinate> {
  const band = latitudeBand(latitude);
  if (!band.ok) return fail(band.error);

  const zone = utmZone(latitude, longitude);
  const { x, y } = transverseMercatorForward(
    latitude,
    longitude,
    centralMeridian(zone),
    ellipsoid,
    UTM_SCALE_FACTOR,
  );

  const hemisphere: "N" | "S" = latitude < 0 ? "S" : "N";
  return ok({
    zone,
    band: band.value,
    hemisphere,
    easting: x + FALSE_EASTING,
    northing: hemisphere === "S" ? y + FALSE_NORTHING_SOUTH : y,
  });
}

/** UTM back to WGS 84 latitude and longitude. Snyder 8-8 to 8-12. */
export function fromUtm(
  coordinate: UtmCoordinate,
  ellipsoid: Ellipsoid = WGS84,
): ToolResult<{ latitude: number; longitude: number }> {
  const { zone, hemisphere, easting, northing } = coordinate;
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
    return fail(`Zone must be a whole number from 1 to 60; got ${zone}.`);
  }
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return fail("Easting and northing must both be numbers.");
  }

  const { a, eSquared: e2 } = ellipsoid;
  const ePrime2 = e2 / (1 - e2);

  const x = easting - FALSE_EASTING;
  const y = hemisphere === "S" ? northing - FALSE_NORTHING_SOUTH : northing;

  const M = y / UTM_SCALE_FACTOR;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const mu = M / (a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));

  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const e1_2 = e1 * e1;
  const e1_3 = e1_2 * e1;
  const e1_4 = e1_3 * e1;

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1_3) / 32) * Math.sin(2 * mu) +
    ((21 * e1_2) / 16 - (55 * e1_4) / 32) * Math.sin(4 * mu) +
    ((151 * e1_3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1_4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const C1 = ePrime2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const oneMinus = 1 - e2 * sinPhi1 * sinPhi1;
  const N1 = a / Math.sqrt(oneMinus);
  const R1 = (a * (1 - e2)) / Math.pow(oneMinus, 1.5);
  const D = x / (N1 * UTM_SCALE_FACTOR);

  const D2 = D * D;
  const D3 = D2 * D;
  const D4 = D3 * D;
  const D5 = D4 * D;
  const D6 = D5 * D;

  const phi =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      (D2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ePrime2) * D4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ePrime2 - 3 * C1 * C1) * D6) / 720);

  const lambda =
    (D -
      ((1 + 2 * T1 + C1) * D3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ePrime2 + 24 * T1 * T1) * D5) / 120) /
    cosPhi1;

  const latitude = phi / RAD;
  const longitude = centralMeridian(zone) + lambda / RAD;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return fail("That easting and northing do not resolve to a point on the ellipsoid.");
  }
  return ok({ latitude, longitude });
}

/**
 * Grid convergence: the angle between grid north and true north at a point, in degrees.
 *
 * This is the correction an investigator needs when a bearing was measured against a grid
 * rather than against true north — a shadow azimuth read off a UTM map, for instance. It is
 * zero on the central meridian and grows towards the zone edges, reaching about 3 degrees at
 * high latitude. First-order approximation, which is well within the error of any bearing
 * measured off a photograph.
 */
export function gridConvergence(latitude: number, longitude: number): number {
  const zone = utmZone(latitude, longitude);
  const dLon = longitude - centralMeridian(zone);
  return Math.atan(Math.tan(dLon * RAD) * Math.sin(latitude * RAD)) / RAD;
}

/** `33T 315428mE 5028745mN`, the way a UTM coordinate is conventionally written. */
export function formatUtm(coordinate: UtmCoordinate): string {
  return `${coordinate.zone}${coordinate.band} ${Math.round(coordinate.easting)}mE ${Math.round(
    coordinate.northing,
  )}mN`;
}

/**
 * Hemisphere from a latitude band letter. Bands C to M are south of the equator, N to X are
 * north of it.
 *
 * **`S` is a band letter, not "south".** Band S covers 32N to 40N — Ankara, Seoul and
 * Oklahoma are all in it. A coordinate written "33S" by somebody meaning "zone 33, southern
 * hemisphere" is roughly 7,500 km from where they meant, and the notation gives no way to
 * tell the two readings apart. This function takes the letter at its documented meaning; the
 * UI states the trap rather than guessing.
 */
export function hemisphereForBand(band: string): "N" | "S" {
  return band >= "N" ? "N" : "S";
}

/** Parse `33T 315428 5028745`, `33T 315428mE 5028745mN`, or `33T,315428,5028745`. */
export function parseUtm(input: string): ToolResult<UtmCoordinate> {
  // Strip the conventional "mE"/"mN" (or bare "E"/"N") suffixes from the two distances.
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/(\d)\s*M?\s*([EN])(?![A-Z0-9])/g, "$1");
  const match = cleaned.match(
    /^(\d{1,2})\s*([C-HJ-NP-X])\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)$/,
  );
  if (!match) {
    return fail(
      "Write a UTM coordinate as zone, band letter, easting, northing — for example 33T 315428 5028745.",
    );
  }
  const [, zoneText = "", bandText = "", eastingText = "", northingText = ""] = match;
  const zone = Number(zoneText);
  if (zone < 1 || zone > 60) return fail(`Zone must be from 1 to 60; got ${zone}.`);

  return ok({
    zone,
    band: bandText,
    hemisphere: hemisphereForBand(bandText),
    easting: Number(eastingText),
    northing: Number(northingText),
  });
}
