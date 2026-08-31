import { fail, ok, type ToolResult } from "./result";

/**
 * Open Location Code, better known as Plus Codes.
 *
 * The specification and its reference implementations are open (Apache 2.0), which is why
 * this format is here and what3words is not — see `WHAT3WORDS_NOTE` below and the tool page,
 * which says the same thing to the reader.
 *
 * A Plus Code is a base-20 encoding of latitude and longitude interleaved into one string.
 * The alphabet omits vowels and the letters that look like digits, so a code cannot
 * accidentally spell a word and is hard to mistranscribe. The code names an **area**, not a
 * point: eight digits is roughly 275 m, ten digits roughly 14 m, eleven roughly 3 m. Reading
 * the centre of a ten-digit code as an exact location claims about 7 m of precision that the
 * code does not carry.
 */

const CODE_ALPHABET = "23456789CFGHJMPQRVWX";
const ENCODING_BASE = 20;
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;
const PADDING = "0";
const LATITUDE_MAX = 90;
const LONGITUDE_MAX = 180;

const PAIR_CODE_LENGTH = 10;
const PAIR_FIRST_PLACE_VALUE = ENCODING_BASE ** (PAIR_CODE_LENGTH / 2 - 1); // 160000
const PAIR_PRECISION = ENCODING_BASE ** 3; // 8000

const GRID_CODE_LENGTH = 5;
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const GRID_LAT_FIRST_PLACE_VALUE = GRID_ROWS ** (GRID_CODE_LENGTH - 1); // 625
const GRID_LNG_FIRST_PLACE_VALUE = GRID_COLUMNS ** (GRID_CODE_LENGTH - 1); // 256

const FINAL_LAT_PRECISION = PAIR_PRECISION * GRID_ROWS ** GRID_CODE_LENGTH; // 25,000,000
const FINAL_LNG_PRECISION = PAIR_PRECISION * GRID_COLUMNS ** GRID_CODE_LENGTH; // 8,192,000

const MAX_DIGIT_COUNT = 15;

/**
 * Why what3words is absent, stated once here and rendered on the tool page.
 *
 * what3words is a proprietary system. Its wordlist and its assignment of words to squares
 * are not published under a licence that permits reimplementation, and the company has
 * pursued takedowns against open reimplementations. There is therefore no honest way to
 * convert a what3words address inside a browser. A tool that appeared to do it would either
 * be calling their API — sending the reader's coordinate to a third party, which is the
 * opposite of what this workbench promises — or fabricating words that look plausible and
 * point at the wrong place. Both are worse than saying so.
 */
export const WHAT3WORDS_NOTE =
  "what3words is not included. Its wordlist is proprietary and unlicensed for reimplementation, so a browser-side converter is not possible without sending your coordinate to their servers. Plus Codes are the open equivalent and are implemented here in full.";

function characterValue(char: string): number {
  return CODE_ALPHABET.indexOf(char.toUpperCase());
}

/** A Plus Code names a box. This is that box. */
export interface CodeArea {
  readonly latitudeLow: number;
  readonly longitudeLow: number;
  readonly latitudeHigh: number;
  readonly longitudeHigh: number;
  readonly latitudeCentre: number;
  readonly longitudeCentre: number;
  /** Digits excluding the separator and any padding. */
  readonly codeLength: number;
  /** Height of the box in metres, at the equator for longitude. */
  readonly boxHeightMetres: number;
  readonly boxWidthMetres: number;
}

/** Clip and wrap the way the specification requires before encoding. */
function clipLatitude(latitude: number): number {
  return Math.min(90, Math.max(-90, latitude));
}

function normaliseLongitude(longitude: number): number {
  let value = longitude;
  while (value < -180) value += 360;
  while (value >= 180) value -= 360;
  return value;
}

/** Height in degrees of the box a code of this length names. */
function latitudePrecision(codeLength: number): number {
  if (codeLength <= PAIR_CODE_LENGTH) {
    return ENCODING_BASE ** (Math.floor(codeLength / -2) + 2);
  }
  return ENCODING_BASE ** -3 / GRID_ROWS ** (codeLength - PAIR_CODE_LENGTH);
}

/**
 * Encode a coordinate. `codeLength` counts significant digits, not characters: 10 is the
 * common "plus code" length, 11 adds one grid refinement digit, 15 is the maximum.
 */
export function encodePlusCode(
  latitude: number,
  longitude: number,
  codeLength = PAIR_CODE_LENGTH,
): ToolResult<string> {
  if (codeLength < 2 || (codeLength < PAIR_CODE_LENGTH && codeLength % 2 === 1)) {
    return fail(
      "A code length below 10 must be an even number of digits (2, 4, 6 or 8). Above 10, any length up to 15 is valid.",
    );
  }
  const length = Math.min(codeLength, MAX_DIGIT_COUNT);
  let lat = clipLatitude(latitude);
  const lng = normaliseLongitude(longitude);

  // The north pole is on the boundary of no box, so nudge it into the last one.
  if (lat === 90) {
    lat = 90 - latitudePrecision(length);
  }

  let code = "";

  // Integer arithmetic throughout: the specification requires it, because doing this in
  // floating point puts points on a box boundary into the wrong box.
  let latVal = Math.floor(Math.round((lat + LATITUDE_MAX) * FINAL_LAT_PRECISION * 1e6) / 1e6);
  let lngVal = Math.floor(Math.round((lng + LONGITUDE_MAX) * FINAL_LNG_PRECISION * 1e6) / 1e6);

  if (length > PAIR_CODE_LENGTH) {
    for (let i = 0; i < GRID_CODE_LENGTH; i += 1) {
      const latDigit = latVal % GRID_ROWS;
      const lngDigit = lngVal % GRID_COLUMNS;
      code = (CODE_ALPHABET[latDigit * GRID_COLUMNS + lngDigit] ?? "") + code;
      latVal = Math.floor(latVal / GRID_ROWS);
      lngVal = Math.floor(lngVal / GRID_COLUMNS);
    }
  } else {
    latVal = Math.floor(latVal / GRID_ROWS ** GRID_CODE_LENGTH);
    lngVal = Math.floor(lngVal / GRID_COLUMNS ** GRID_CODE_LENGTH);
  }

  for (let i = 0; i < PAIR_CODE_LENGTH / 2; i += 1) {
    code = (CODE_ALPHABET[lngVal % ENCODING_BASE] ?? "") + code;
    code = (CODE_ALPHABET[latVal % ENCODING_BASE] ?? "") + code;
    latVal = Math.floor(latVal / ENCODING_BASE);
    lngVal = Math.floor(lngVal / ENCODING_BASE);
  }

  const withSeparator =
    code.slice(0, SEPARATOR_POSITION) + SEPARATOR + code.slice(SEPARATOR_POSITION);

  if (length >= SEPARATOR_POSITION) {
    return ok(withSeparator.slice(0, length + 1));
  }
  return ok(
    withSeparator.slice(0, length) + PADDING.repeat(SEPARATOR_POSITION - length) + SEPARATOR,
  );
}

/** Whether a string is a well-formed full Plus Code. Short codes are rejected — see below. */
export function isFullPlusCode(code: string): boolean {
  const upper = code.toUpperCase();
  const separatorIndex = upper.indexOf(SEPARATOR);
  if (separatorIndex !== SEPARATOR_POSITION) return false;
  if (upper.indexOf(SEPARATOR, separatorIndex + 1) !== -1) return false;
  if (upper.length === SEPARATOR_POSITION + 1) return true;
  if (upper.length < SEPARATOR_POSITION + 3) return false;
  const paddingIndex = upper.indexOf(PADDING);
  if (paddingIndex > -1) {
    if (paddingIndex < 2 || paddingIndex % 2 === 1) return false;
    if (!/^0+\+$/.test(upper.slice(paddingIndex))) return false;
  }
  const digits = upper.replace(SEPARATOR, "").replace(/0+$/, "");
  return [...digits].every((char) => characterValue(char) >= 0);
}

const METRES_PER_DEGREE_LATITUDE = 111_320;

/** Decode a full Plus Code into the box it names. */
export function decodePlusCode(code: string): ToolResult<CodeArea> {
  const upper = code.trim().toUpperCase();
  if (!isFullPlusCode(upper)) {
    if (upper.includes(SEPARATOR) && upper.indexOf(SEPARATOR) < SEPARATOR_POSITION) {
      return fail(
        "That is a shortened Plus Code. It only resolves relative to a nearby place name or coordinate, which this tool does not have, so it cannot be decoded here. Use the full code — the one with eight characters before the plus sign.",
      );
    }
    return fail(
      "That is not a valid Plus Code. A full code has eight characters, then a plus sign, then two or more — for example 8FVC9G8F+6W.",
    );
  }

  const stripped = upper.replace(SEPARATOR, "").replace(/0+$/, "");

  let normalLat = -LATITUDE_MAX * PAIR_PRECISION;
  let normalLng = -LONGITUDE_MAX * PAIR_PRECISION;
  let extraLat = 0;
  let extraLng = 0;

  const pairDigits = Math.min(stripped.length, PAIR_CODE_LENGTH);
  let placeValue = PAIR_FIRST_PLACE_VALUE;
  for (let i = 0; i < pairDigits; i += 2) {
    normalLat += characterValue(stripped[i] ?? "") * placeValue;
    normalLng += characterValue(stripped[i + 1] ?? "") * placeValue;
    if (i < pairDigits - 2) placeValue /= ENCODING_BASE;
  }

  let latPrecision = placeValue / PAIR_PRECISION;
  let lngPrecision = placeValue / PAIR_PRECISION;
  let digitCount = pairDigits;

  if (stripped.length > PAIR_CODE_LENGTH) {
    let rowPlaceValue = GRID_LAT_FIRST_PLACE_VALUE;
    let columnPlaceValue = GRID_LNG_FIRST_PLACE_VALUE;
    digitCount = Math.min(stripped.length, MAX_DIGIT_COUNT);
    for (let i = PAIR_CODE_LENGTH; i < digitCount; i += 1) {
      const value = characterValue(stripped[i] ?? "");
      extraLat += Math.floor(value / GRID_COLUMNS) * rowPlaceValue;
      extraLng += (value % GRID_COLUMNS) * columnPlaceValue;
      if (i < digitCount - 1) {
        rowPlaceValue /= GRID_ROWS;
        columnPlaceValue /= GRID_COLUMNS;
      }
    }
    latPrecision = rowPlaceValue / FINAL_LAT_PRECISION;
    lngPrecision = columnPlaceValue / FINAL_LNG_PRECISION;
  }

  const latitudeLow = normalLat / PAIR_PRECISION + extraLat / FINAL_LAT_PRECISION;
  const longitudeLow = normalLng / PAIR_PRECISION + extraLng / FINAL_LNG_PRECISION;
  const latitudeHigh = latitudeLow + latPrecision;
  const longitudeHigh = longitudeLow + lngPrecision;
  const latitudeCentre = Math.min(latitudeLow + latPrecision / 2, 90);
  const longitudeCentre = Math.min(longitudeLow + lngPrecision / 2, 180);

  return ok({
    latitudeLow,
    longitudeLow,
    latitudeHigh,
    longitudeHigh,
    latitudeCentre,
    longitudeCentre,
    codeLength: digitCount,
    boxHeightMetres: latPrecision * METRES_PER_DEGREE_LATITUDE,
    boxWidthMetres:
      lngPrecision * METRES_PER_DEGREE_LATITUDE * Math.cos((latitudeCentre * Math.PI) / 180),
  });
}
