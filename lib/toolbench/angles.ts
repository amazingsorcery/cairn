import { fail, ok, type ToolResult } from "./result";

/**
 * Latitude and longitude in the three notations people write them in, and a parser tolerant
 * enough to take what is actually on the page in front of the reader.
 *
 * The three notations, all of the same point:
 *
 *   DD   51.477928, -0.001545              decimal degrees
 *   DDM  51 28.6757 N, 000 00.0927 W       degrees and decimal minutes  (marine, aviation)
 *   DMS  51 28 40.54 N, 000 00 05.56 W     degrees, minutes, seconds    (maps, EXIF)
 *
 * The order trap: almost everything geographic writes latitude first, and GeoJSON, WKT and
 * most GIS internals write longitude first. Transposing them puts a point in the Indian
 * Ocean, which is why this module always labels which is which and never returns a bare pair.
 */

export type AngleNotation = "decimalDegrees" | "degreesDecimalMinutes" | "degreesMinutesSeconds";

export interface ParsedCoordinate {
  readonly latitude: number;
  readonly longitude: number;
  /** Which notation the input turned out to be in, so the UI can echo it back. */
  readonly notation: AngleNotation;
  /** True when the input carried N/S/E/W letters rather than relying on sign and order. */
  readonly hemispheresExplicit: boolean;
}

interface AngleGroup {
  readonly parts: readonly number[];
  readonly hemisphere: string | null;
  readonly negativeSign: boolean;
}

/** Anything that can stand in for a degree, minute or second mark gets flattened to a space. */
function normalise(input: string): string {
  return input
    .replace(/[°º⁰]/g, " ")
    .replace(/[′’'`´]/g, " ")
    .replace(/[″”"〃]/g, " ")
    .replace(/[−–—]/g, "-")
    .replace(/[,;]/g, " ")
    .toUpperCase();
}

/**
 * Split the input into two groups of numbers, each optionally carrying a hemisphere letter.
 *
 * Two strategies, because coordinates are written both ways:
 *
 *   - **With hemisphere letters**, a letter delimits its group. It may lead ("N51 28.6757")
 *     or trail ("51 28.6757 N"), and once a group has taken a leading letter the next letter
 *     must belong to the following group, or "N51 W0" would read as one group claiming both
 *     hemispheres.
 *   - **Without them**, there is nothing to delimit on, so the numbers are split down the
 *     middle. Latitude and longitude always carry the same number of components, so an even
 *     count is required and an odd one is an error rather than a guess.
 */
function groupTokens(input: string): ToolResult<readonly AngleGroup[]> {
  const tokens = normalise(input).match(/[NSEW]|[-+]?\d+(?:\.\d+)?|\S/g) ?? [];

  for (const token of tokens) {
    if (!/^[NSEW]$/.test(token) && !/^[-+]?\d/.test(token)) {
      return fail(`"${token}" is not something this parser recognises in a coordinate.`);
    }
  }

  const hasLetters = tokens.some((token) => /^[NSEW]$/.test(token));

  if (!hasLetters) {
    const numbers = tokens.map((token) => Number(token));
    if (numbers.length === 0 || numbers.length % 2 !== 0 || numbers.length > 6) {
      return fail(
        `A coordinate pair has the same number of components on each side; found ${numbers.length}. Write it as "51.4779, -0.0015" or "51 28 40.5 N, 0 0 5.6 W".`,
      );
    }
    const half = numbers.length / 2;
    const build = (values: readonly number[]): AngleGroup => ({
      parts: values.map((value) => Math.abs(value)),
      hemisphere: null,
      negativeSign: (values[0] ?? 0) < 0 || Object.is(values[0], -0),
    });
    return ok([build(numbers.slice(0, half)), build(numbers.slice(half))]);
  }

  const groups: AngleGroup[] = [];
  let parts: number[] = [];
  let hemisphere: string | null = null;
  let negativeSign = false;
  let leadingHemisphere: string | null = null;

  const flush = (): void => {
    if (parts.length === 0 && hemisphere === null && leadingHemisphere === null) return;
    groups.push({ parts, hemisphere: hemisphere ?? leadingHemisphere, negativeSign });
    parts = [];
    hemisphere = null;
    leadingHemisphere = null;
    negativeSign = false;
  };

  for (const token of tokens) {
    if (/^[NSEW]$/.test(token)) {
      if (parts.length === 0 || leadingHemisphere !== null) {
        flush();
        leadingHemisphere = token;
      } else {
        hemisphere = token;
        flush();
      }
      continue;
    }
    if (parts.length === 0 && token.startsWith("-")) negativeSign = true;
    if (parts.length >= 3) flush();
    parts.push(Math.abs(Number(token)));
  }
  flush();

  return ok(groups);
}

function groupToDegrees(group: AngleGroup): ToolResult<{ value: number; notation: AngleNotation }> {
  const [degrees, minutes, seconds] = group.parts;
  if (degrees === undefined) return fail("A coordinate needs at least a degrees value.");

  if (minutes !== undefined && minutes >= 60) return fail(`Minutes must be under 60; got ${minutes}.`);
  if (seconds !== undefined && seconds >= 60) return fail(`Seconds must be under 60; got ${seconds}.`);

  const magnitude = degrees + (minutes ?? 0) / 60 + (seconds ?? 0) / 3600;
  const notation: AngleNotation =
    seconds !== undefined
      ? "degreesMinutesSeconds"
      : minutes !== undefined
        ? "degreesDecimalMinutes"
        : "decimalDegrees";

  const hemisphereNegative = group.hemisphere === "S" || group.hemisphere === "W";
  if (hemisphereNegative && group.negativeSign) {
    return fail(
      `"${group.hemisphere}" and a minus sign both make this negative. One of them is a mistake, and guessing which would be worse than asking.`,
    );
  }

  return ok({ value: hemisphereNegative || group.negativeSign ? -magnitude : magnitude, notation });
}

/**
 * Parse a coordinate pair written in any of the three notations.
 *
 * Where hemisphere letters are present they decide which value is latitude, so
 * `W0.0015 N51.4779` parses correctly despite being written backwards. Without letters the
 * conventional order — latitude first — is assumed and reported, because there is nothing
 * else to go on and silently guessing is how points end up transposed.
 */
export function parseCoordinatePair(input: string): ToolResult<ParsedCoordinate> {
  if (input.trim().length === 0) return fail("Enter a coordinate.");

  const grouped = groupTokens(input);
  if (!grouped.ok) return fail(grouped.error);
  const groups = grouped.value;

  if (groups.length !== 2) {
    return fail(
      `Expected two values, latitude and longitude; found ${groups.length}. Separate them with a comma.`,
    );
  }

  const [first, second] = groups;
  if (first === undefined || second === undefined) return fail("Expected two values.");

  const firstParsed = groupToDegrees(first);
  if (!firstParsed.ok) return fail(firstParsed.error);
  const secondParsed = groupToDegrees(second);
  if (!secondParsed.ok) return fail(secondParsed.error);
  const firstValue = firstParsed.value;
  const secondValue = secondParsed.value;

  const letters = [first.hemisphere, second.hemisphere].filter(
    (letter): letter is string => letter !== null,
  );
  const hemispheresExplicit = letters.length === 2;

  let latitude: number;
  let longitude: number;

  if (hemispheresExplicit) {
    const firstIsLatitude = first.hemisphere === "N" || first.hemisphere === "S";
    const secondIsLatitude = second.hemisphere === "N" || second.hemisphere === "S";
    if (firstIsLatitude === secondIsLatitude) {
      return fail(
        "Both values carry the same kind of hemisphere letter. One must be N or S and the other E or W.",
      );
    }
    latitude = firstIsLatitude ? firstValue.value : secondValue.value;
    longitude = firstIsLatitude ? secondValue.value : firstValue.value;
  } else if (letters.length === 1) {
    return fail("One value has a hemisphere letter and the other does not. Give both or neither.");
  } else {
    latitude = firstValue.value;
    longitude = secondValue.value;
  }

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return fail(`Latitude must be between -90 and 90; got ${latitude}.`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return fail(`Longitude must be between -180 and 180; got ${longitude}.`);
  }

  // The finer of the two notations wins: "51 28.6757 N, 0 W" is DDM overall.
  const rank: Record<AngleNotation, number> = {
    decimalDegrees: 0,
    degreesDecimalMinutes: 1,
    degreesMinutesSeconds: 2,
  };
  const notation =
    rank[firstValue.notation] >= rank[secondValue.notation]
      ? firstValue.notation
      : secondValue.notation;

  return ok({ latitude, longitude, notation, hemispheresExplicit });
}

export type Axis = "latitude" | "longitude";

function hemisphereFor(value: number, axis: Axis): string {
  if (axis === "latitude") return value < 0 ? "S" : "N";
  return value < 0 ? "W" : "E";
}

/**
 * Round-then-carry, so 59.9999 seconds becomes the next whole minute rather than "60".
 * Formatting a coordinate as `51 28 60.00 N` is a defect readers notice immediately.
 */
function splitSexagesimal(
  value: number,
  secondsDecimals: number,
): { degrees: number; minutes: number; seconds: number } {
  const total = Math.abs(value);
  let degrees = Math.floor(total);
  let minutes = Math.floor((total - degrees) * 60);
  let seconds = Number((((total - degrees) * 60 - minutes) * 60).toFixed(secondsDecimals));
  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }
  return { degrees, minutes, seconds };
}

/** `51 28 40.54 N`, with the degree pad a map reader expects (2 digits lat, 3 lon). */
export function formatDms(value: number, axis: Axis, secondsDecimals = 2): string {
  const { degrees, minutes, seconds } = splitSexagesimal(value, secondsDecimals);
  const pad = axis === "latitude" ? 2 : 3;
  return `${String(degrees).padStart(pad, "0")}°${String(minutes).padStart(2, "0")}'${seconds
    .toFixed(secondsDecimals)
    .padStart(secondsDecimals > 0 ? secondsDecimals + 3 : 2, "0")}"${hemisphereFor(value, axis)}`;
}

/** `51 28.6757 N` — the notation marine and aviation charts use. */
export function formatDdm(value: number, axis: Axis, minuteDecimals = 4): string {
  const total = Math.abs(value);
  let degrees = Math.floor(total);
  let minutes = Number(((total - degrees) * 60).toFixed(minuteDecimals));
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }
  const pad = axis === "latitude" ? 2 : 3;
  return `${String(degrees).padStart(pad, "0")}°${minutes
    .toFixed(minuteDecimals)
    .padStart(minuteDecimals + 3, "0")}'${hemisphereFor(value, axis)}`;
}

/**
 * Decimal degrees at a fixed precision.
 *
 * Six decimal places is about 0.11 m at the equator, which is finer than any consumer GPS
 * fix. Publishing more digits than the source justifies is a claim about precision the
 * evidence does not support.
 */
export function formatDecimal(value: number, decimals = 6): string {
  return value.toFixed(decimals);
}
