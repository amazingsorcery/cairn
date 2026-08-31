import { fail, ok, type ToolResult } from "./result";
import {
  fromUtm,
  hemisphereForBand,
  latitudeBand,
  toUtm,
  type UtmCoordinate,
  WGS84,
  type Ellipsoid,
} from "./utm";

/**
 * The Military Grid Reference System, in its WGS 84 form (the "AA" 100,000-metre square
 * lettering scheme, used by NATO and by every civilian MGRS tool worth the name).
 *
 * An MGRS reference is a UTM coordinate with the leading digits replaced by two letters
 * naming a 100 km square, so `33T UM 15428 28745` is zone 33, band T, the square UM, and
 * 15428 m east and 28745 m north inside it. Its usefulness is that precision is visible in
 * the length: two digits per axis is a 1 km box, three is 100 m, four is 10 m, five is 1 m.
 * A reference
 * quoted to 1 m from a source that measured to 100 m is a false precision claim that MGRS,
 * unlike decimal degrees, makes obvious.
 *
 * Not implemented: the polar UPS grid (bands A, B, Y, Z), and the older Bessel-based
 * lettering schemes still found on mid-century maps. A reference from one of those decoded
 * with this code lands in the wrong 100 km square entirely.
 */

/** Column letters, in three sets of eight that repeat every three zones. I and O are omitted. */
const COLUMN_SETS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"] as const;
/** Row letters: 20 of them, repeating every 2,000,000 m of northing. I and O are omitted. */
const ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV";
/** Even-numbered zones start their row lettering five places along. */
const EVEN_ZONE_ROW_OFFSET = 5;

export interface MgrsReference {
  readonly zone: number;
  readonly band: string;
  /** The two 100 km square letters, e.g. `UM`. */
  readonly square: string;
  /** Metres east within the 100 km square, 0 to 99999. */
  readonly easting: number;
  /** Metres north within the 100 km square, 0 to 99999. */
  readonly northing: number;
  /** Digits per axis as written: 1 (10 km) to 5 (1 m). */
  readonly precisionDigits: number;
}

function columnLetter(zone: number, easting: number): ToolResult<string> {
  const set = COLUMN_SETS[(zone - 1) % 3];
  if (set === undefined) return fail(`Zone ${zone} has no column letter set.`);
  const index = Math.floor(easting / 100_000) - 1;
  const letter = set[index];
  if (letter === undefined) {
    return fail(
      `An easting of ${Math.round(easting)} is outside the 100,000 to 900,000 m range a UTM zone occupies.`,
    );
  }
  return ok(letter);
}

function rowLetter(zone: number, northing: number): string {
  const base = Math.floor(northing / 100_000) % 20;
  const offset = zone % 2 === 0 ? EVEN_ZONE_ROW_OFFSET : 0;
  return ROW_LETTERS[(base + offset) % 20] ?? "A";
}

/** WGS 84 latitude and longitude to an MGRS reference. */
export function toMgrs(
  latitude: number,
  longitude: number,
  precisionDigits = 5,
  ellipsoid: Ellipsoid = WGS84,
): ToolResult<MgrsReference> {
  if (!Number.isInteger(precisionDigits) || precisionDigits < 1 || precisionDigits > 5) {
    return fail("Precision must be 1 to 5 digits per axis (10 km down to 1 m).");
  }
  const utm = toUtm(latitude, longitude, ellipsoid);
  if (!utm.ok) return fail(utm.error);

  const column = columnLetter(utm.value.zone, utm.value.easting);
  if (!column.ok) return fail(column.error);
  const row = rowLetter(utm.value.zone, utm.value.northing);

  return ok({
    zone: utm.value.zone,
    band: utm.value.band,
    square: `${column.value}${row}`,
    easting: Math.floor(utm.value.easting) % 100_000,
    northing: Math.floor(utm.value.northing) % 100_000,
    precisionDigits,
  });
}

/** `33T UM 15428 28745`, truncated to the reference's own precision. */
export function formatMgrs(reference: MgrsReference): string {
  const divisor = Math.pow(10, 5 - reference.precisionDigits);
  const east = String(Math.floor(reference.easting / divisor)).padStart(reference.precisionDigits, "0");
  const north = String(Math.floor(reference.northing / divisor)).padStart(reference.precisionDigits, "0");
  return `${reference.zone}${reference.band} ${reference.square} ${east} ${north}`;
}

/** Parse `33TUM1542828745`, `33T UM 15428 28745`, or `33T UM 1542 2874`. */
export function parseMgrs(input: string): ToolResult<MgrsReference> {
  const cleaned = input.toUpperCase().replace(/\s+/g, "");
  const match = cleaned.match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/);
  if (!match) {
    return fail(
      "Write an MGRS reference as zone, band, two square letters, then an even number of digits — for example 33T UM 15428 28745.",
    );
  }
  const [, zoneText = "", band = "", column = "", row = "", digits = ""] = match;
  const zone = Number(zoneText);
  if (zone < 1 || zone > 60) return fail(`Zone must be from 1 to 60; got ${zone}.`);
  if (digits.length % 2 !== 0) {
    return fail(
      `A grid reference has the same number of digits on each axis; this has ${digits.length}, which cannot be split evenly.`,
    );
  }
  if (digits.length > 10) return fail("MGRS goes no finer than five digits per axis (1 m).");

  const precisionDigits = digits.length / 2;
  const scale = precisionDigits === 0 ? 0 : Math.pow(10, 5 - precisionDigits);
  const east = precisionDigits === 0 ? 0 : Number(digits.slice(0, precisionDigits)) * scale;
  const north = precisionDigits === 0 ? 0 : Number(digits.slice(precisionDigits)) * scale;

  return ok({
    zone,
    band,
    square: `${column}${row}`,
    easting: east,
    northing: north,
    precisionDigits: precisionDigits === 0 ? 1 : precisionDigits,
  });
}

/**
 * MGRS back to a UTM coordinate.
 *
 * The row letters repeat every 2,000,000 m, so recovering the full northing needs to know
 * roughly where in the world we are. The band letter supplies that: we take the northing
 * band the letter implies and choose the 2,000,000 m multiple that lands inside it. This is
 * the standard resolution and it is why an MGRS reference without its band letter is
 * genuinely ambiguous rather than merely inconvenient.
 */
export function mgrsToUtm(reference: MgrsReference): ToolResult<UtmCoordinate> {
  const { zone, band, square } = reference;
  const columnChar = square[0];
  const rowChar = square[1];
  if (columnChar === undefined || rowChar === undefined) {
    return fail("A 100 km square is two letters.");
  }

  const set = COLUMN_SETS[(zone - 1) % 3];
  if (set === undefined) return fail(`Zone ${zone} has no column letter set.`);
  const columnIndex = set.indexOf(columnChar);
  if (columnIndex < 0) {
    return fail(
      `"${columnChar}" is not a column letter for zone ${zone}. Zone ${zone} uses ${set[0]} to ${set[set.length - 1]}.`,
    );
  }
  const easting = (columnIndex + 1) * 100_000 + reference.easting;

  const offset = zone % 2 === 0 ? EVEN_ZONE_ROW_OFFSET : 0;
  const rowIndex = ROW_LETTERS.indexOf(rowChar);
  if (rowIndex < 0) return fail(`"${rowChar}" is not a row letter.`);
  const rowNorthing = (((rowIndex - offset) % 20) + 20) % 20;

  const hemisphere = hemisphereForBand(band);
  // Approximate northing at the southern edge of the band, used only to pick which
  // 2,000,000 m repetition of the row letters this reference belongs to.
  const bandIndex = "CDEFGHJKLMNPQRSTUVWX".indexOf(band);
  if (bandIndex < 0) return fail(`"${band}" is not a latitude band letter.`);
  const bandSouthLatitude = -80 + bandIndex * 8;
  const approximate = toUtm(Math.max(-80, bandSouthLatitude), (zone - 1) * 6 - 180 + 3, WGS84);
  if (!approximate.ok) return fail(approximate.error);

  const target = approximate.value.northing;
  const base = rowNorthing * 100_000 + reference.northing;
  let northing = base;
  // Step in 2,000,000 m increments to the repetition nearest the band's own northing.
  while (northing < target - 1_000_000) northing += 2_000_000;
  while (northing > target + 1_000_000) northing -= 2_000_000;
  if (northing < 0) northing += 2_000_000;

  return ok({ zone, band, hemisphere, easting, northing });
}

/**
 * MGRS to WGS 84 latitude and longitude, at the south-west corner of the square the
 * reference names. A reference is an area, not a point: `33T UM 15 28` is a 1 km box, and
 * reporting its corner as "the location" overstates what the source said by up to 1.4 km.
 */
export function fromMgrs(
  reference: MgrsReference,
  ellipsoid: Ellipsoid = WGS84,
): ToolResult<{ latitude: number; longitude: number; boxMetres: number }> {
  const utm = mgrsToUtm(reference);
  if (!utm.ok) return fail(utm.error);
  const point = fromUtm(utm.value, ellipsoid);
  if (!point.ok) return fail(point.error);

  const band = latitudeBand(point.value.latitude);
  if (band.ok && band.value !== reference.band) {
    return fail(
      `The digits resolve to band ${band.value}, but the reference says band ${reference.band}. One of them is wrong — most often a mistyped square letter.`,
    );
  }

  return ok({
    latitude: point.value.latitude,
    longitude: point.value.longitude,
    boxMetres: Math.pow(10, 5 - reference.precisionDigits),
  });
}
