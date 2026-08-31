import { fail, ok, type ToolResult } from "./result";

/**
 * Timestamp conversion across the epochs an investigator actually meets.
 *
 * Filesystems, registry hives, browser databases, log lines and archive headers each count
 * from a different zero, at a different resolution, and often with no zone recorded at all.
 * Reading `133200000000000000` as a Unix timestamp puts an event four billion years in the
 * future; reading it as a Windows FILETIME puts it in 2023.
 *
 * Two things are true of every conversion here and are stated in the UI:
 *
 *   - **Unix time ignores leap seconds.** It is not elapsed SI seconds since 1970. For
 *     ordinary investigative work this is immaterial; for anything sub-second across a leap
 *     second boundary it is not.
 *   - **An epoch value carries no time zone.** Every number below is an instant in UTC. When
 *     a source records local time with no offset — a FAT directory entry, an EXIF
 *     `DateTimeOriginal` without `OffsetTimeOriginal`, a camera with an unset clock — the
 *     zone is missing from the evidence, not from this tool, and no conversion can recover it.
 */

/** Seconds between 1601-01-01 and 1970-01-01. */
const SECONDS_1601_TO_1970 = 11_644_473_600n;
/** 100-nanosecond intervals between 1601-01-01 and 1970-01-01. The FILETIME Unix epoch. */
export const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
/** Microseconds between 1601-01-01 and 1970-01-01. The WebKit/Chrome epoch offset. */
export const WEBKIT_UNIX_EPOCH = SECONDS_1601_TO_1970 * 1_000_000n;
/** Seconds between 1970-01-01 and 2001-01-01. Apple's `kCFAbsoluteTimeIntervalSince1970`. */
export const MAC_ABSOLUTE_EPOCH_OFFSET = 978_307_200;
/** Seconds between 1904-01-01 and 1970-01-01, the HFS/HFS+ epoch. */
export const HFS_EPOCH_OFFSET = 2_082_844_800;

export const TIMESTAMP_FORMATS = [
  "unixSeconds",
  "unixMilliseconds",
  "iso8601",
  "windowsFiletime",
  "webkitMicroseconds",
  "macAbsolute",
  "hfsPlus",
  "dosDateTime",
] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMATS)[number];

export interface TimestampFormatInfo {
  readonly id: TimestampFormat;
  readonly label: string;
  /** Where a reader meets this format, so they can recognise it in the wild. */
  readonly seenIn: string;
  readonly resolution: string;
}

export const TIMESTAMP_FORMAT_INFO: readonly TimestampFormatInfo[] = [
  {
    id: "unixSeconds",
    label: "Unix seconds",
    seenIn: "Most APIs and log formats, `stat` output, JWT `exp` and `iat`.",
    resolution: "1 second",
  },
  {
    id: "unixMilliseconds",
    label: "Unix milliseconds",
    seenIn: "JavaScript `Date.now()`, Java, Elasticsearch, most JSON event streams.",
    resolution: "1 millisecond",
  },
  {
    id: "iso8601",
    label: "ISO 8601 / RFC 3339",
    seenIn: "Anything written to be read by a human and a machine at once.",
    resolution: "as written",
  },
  {
    id: "windowsFiletime",
    label: "Windows FILETIME",
    seenIn: "NTFS `$MFT` records, registry hive key write times, Active Directory `lastLogon`, Prefetch, `.lnk` shortcuts.",
    resolution: "100 nanoseconds",
  },
  {
    id: "webkitMicroseconds",
    label: "WebKit / Chrome time",
    seenIn: "Chrome, Edge and Electron `History`, `Cookies` and `Login Data` SQLite databases.",
    resolution: "1 microsecond",
  },
  {
    id: "macAbsolute",
    label: "Mac absolute time (CFAbsoluteTime)",
    seenIn: "macOS and iOS plists, Core Data stores, `kMDItem*` Spotlight attributes, APFS-era Apple logs.",
    resolution: "sub-second, as a float",
  },
  {
    id: "hfsPlus",
    label: "HFS+ time",
    seenIn: "HFS and HFS+ catalogue records, older Mac and QuickTime container atoms.",
    resolution: "1 second",
  },
  {
    id: "dosDateTime",
    label: "MS-DOS / FAT date-time",
    seenIn: "ZIP central directory entries, FAT32 directory entries, some installer manifests.",
    resolution: "2 seconds, and no time zone at all",
  },
];

/** Instants outside this window are almost certainly a misread format, not a real event. */
const PLAUSIBLE_FROM = Date.UTC(1980, 0, 1);
const PLAUSIBLE_TO = Date.UTC(2100, 0, 1);

export interface Instant {
  readonly date: Date;
  /**
   * What the source recorded below millisecond resolution and a `Date` cannot hold. Present
   * only for FILETIME and WebKit values; stated rather than silently dropped.
   */
  readonly discardedSubMillisecond: string | null;
}

function instantFromMilliseconds(ms: number, discarded: string | null = null): ToolResult<Instant> {
  if (!Number.isFinite(ms)) return fail("That value is not a finite number.");
  // The ECMAScript time value range: +/-8.64e15 ms from the epoch.
  if (Math.abs(ms) > 8.64e15) {
    return fail("That instant falls outside the range a date can represent (+/- 273,790 years).");
  }
  return ok({ date: new Date(ms), discardedSubMillisecond: discarded });
}

function parseBigInt(input: string): ToolResult<bigint> {
  const cleaned = input.trim().replace(/[\s,_]/g, "");
  if (!/^-?\d+$/.test(cleaned)) return fail("Enter a whole number of ticks.");
  try {
    return ok(BigInt(cleaned));
  } catch {
    return fail("Enter a whole number of ticks.");
  }
}

function parseFloatStrict(input: string): ToolResult<number> {
  const cleaned = input.trim().replace(/[\s,_]/g, "");
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(cleaned)) return fail("Enter a number.");
  const value = Number(cleaned);
  return Number.isFinite(value) ? ok(value) : fail("Enter a number.");
}

/** Parse one value in a stated format into an instant. */
export function parseTimestamp(format: TimestampFormat, input: string): ToolResult<Instant> {
  switch (format) {
    case "unixSeconds": {
      const value = parseFloatStrict(input);
      return value.ok ? instantFromMilliseconds(value.value * 1000) : fail(value.error);
    }
    case "unixMilliseconds": {
      const value = parseFloatStrict(input);
      return value.ok ? instantFromMilliseconds(value.value) : fail(value.error);
    }
    case "iso8601": {
      const trimmed = input.trim();
      if (trimmed.length === 0) return fail("Enter a date.");
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        return fail("That is not a date this browser can parse. Try 2026-08-31T14:05:00Z.");
      }
      return ok({ date: parsed, discardedSubMillisecond: null });
    }
    case "windowsFiletime": {
      const ticks = parseBigInt(input);
      if (!ticks.ok) return fail(ticks.error);
      const sinceEpoch = ticks.value - FILETIME_UNIX_EPOCH;
      const ms = sinceEpoch / 10_000n;
      const remainder = sinceEpoch - ms * 10_000n;
      return instantFromMilliseconds(
        Number(ms),
        remainder === 0n ? null : `${remainder} x 100 ns`,
      );
    }
    case "webkitMicroseconds": {
      const ticks = parseBigInt(input);
      if (!ticks.ok) return fail(ticks.error);
      const sinceEpoch = ticks.value - WEBKIT_UNIX_EPOCH;
      const ms = sinceEpoch / 1000n;
      const remainder = sinceEpoch - ms * 1000n;
      return instantFromMilliseconds(Number(ms), remainder === 0n ? null : `${remainder} us`);
    }
    case "macAbsolute": {
      const value = parseFloatStrict(input);
      if (!value.ok) return fail(value.error);
      return instantFromMilliseconds((value.value + MAC_ABSOLUTE_EPOCH_OFFSET) * 1000);
    }
    case "hfsPlus": {
      const value = parseFloatStrict(input);
      if (!value.ok) return fail(value.error);
      return instantFromMilliseconds((value.value - HFS_EPOCH_OFFSET) * 1000);
    }
    case "dosDateTime":
      return parseDosDateTime(input);
  }
}

/**
 * MS-DOS packed date-time, as a single 32-bit value written `(date << 16) | time`.
 *
 * Bit layout, from the FAT specification: the high word holds year-1980 in bits 9-15,
 * month in 5-8 and day in 0-4; the low word holds hour in bits 11-15, minute in 5-10 and
 * seconds/2 in 0-4. Two-second resolution, and no time zone whatsoever — a ZIP entry made in
 * Jakarta and one made in Reykjavik record the same wall clock with nothing to tell them
 * apart. We therefore interpret it as UTC and say so, because there is no honest alternative.
 */
export function parseDosDateTime(input: string): ToolResult<Instant> {
  const cleaned = input.trim().replace(/^0x/i, "").replace(/[\s,_]/g, "");
  const value = /^[0-9a-fA-F]+$/.test(cleaned) && /[a-fA-F]/.test(cleaned)
    ? Number.parseInt(cleaned, 16)
    : Number(cleaned);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return fail("Enter the packed 32-bit value, in decimal or as 0x-prefixed hex.");
  }
  const datePart = (value >>> 16) & 0xffff;
  const timePart = value & 0xffff;
  const year = 1980 + ((datePart >> 9) & 0x7f);
  const month = (datePart >> 5) & 0x0f;
  const day = datePart & 0x1f;
  const hour = (timePart >> 11) & 0x1f;
  const minute = (timePart >> 5) & 0x3f;
  const second = (timePart & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 58) {
    return fail(
      `Those bits do not form a valid date (year ${year}, month ${month}, day ${day}, ${hour}:${minute}). Check the byte order — DOS values are stored little-endian.`,
    );
  }
  return instantFromMilliseconds(Date.UTC(year, month - 1, day, hour, minute, second));
}

export interface TimestampSet {
  readonly unixSeconds: string;
  readonly unixMilliseconds: string;
  readonly iso8601: string;
  readonly windowsFiletime: string;
  readonly webkitMicroseconds: string;
  readonly macAbsolute: string;
  readonly hfsPlus: string;
  readonly dosDateTime: string;
}

/** One instant expressed in every format. Values out of a format's range say so. */
export function toAllFormats(date: Date): TimestampSet {
  const ms = date.getTime();
  const msBig = BigInt(Math.trunc(ms));
  const seconds = ms / 1000;

  const dosYear = date.getUTCFullYear() - 1980;
  let dos: string;
  if (dosYear < 0 || dosYear > 127) {
    dos = "out of range (FAT covers 1980-2107)";
  } else {
    const dateWord = (dosYear << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    const timeWord =
      (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const packed = ((dateWord << 16) >>> 0) + timeWord;
    dos = `0x${packed.toString(16).padStart(8, "0")}`;
  }

  return {
    unixSeconds: Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3),
    unixMilliseconds: String(ms),
    iso8601: date.toISOString(),
    windowsFiletime: String(msBig * 10_000n + FILETIME_UNIX_EPOCH),
    webkitMicroseconds: String(msBig * 1000n + WEBKIT_UNIX_EPOCH),
    macAbsolute: String(seconds - MAC_ABSOLUTE_EPOCH_OFFSET),
    hfsPlus: String(seconds + HFS_EPOCH_OFFSET),
    dosDateTime: dos,
  };
}

export interface FormatGuess {
  readonly format: TimestampFormat;
  readonly instant: Instant;
  /** True when the instant lands between 1980 and 2100 — the range real evidence occupies. */
  readonly plausible: boolean;
}

/**
 * Given a bare number with no label, which epochs would put it somewhere believable?
 *
 * This is the question an investigator actually has: a value has been pulled out of a blob
 * and nobody wrote down what it means. Magnitude alone identifies most of them, because the
 * epochs are orders of magnitude apart — but two candidates can both land in range, and when
 * they do the tool shows both rather than picking one.
 */
export function guessFormats(input: string): readonly FormatGuess[] {
  const candidates: TimestampFormat[] = [
    "unixSeconds",
    "unixMilliseconds",
    "windowsFiletime",
    "webkitMicroseconds",
    "macAbsolute",
    "hfsPlus",
    "dosDateTime",
  ];
  const guesses: FormatGuess[] = [];
  for (const format of candidates) {
    const parsed = parseTimestamp(format, input);
    if (!parsed.ok) continue;
    const ms = parsed.value.date.getTime();
    if (Number.isNaN(ms)) continue;
    guesses.push({
      format,
      instant: parsed.value,
      plausible: ms >= PLAUSIBLE_FROM && ms < PLAUSIBLE_TO,
    });
  }
  return guesses.sort((a, b) => Number(b.plausible) - Number(a.plausible));
}

/**
 * The IANA zones this runtime knows. Falls back to a short list where the environment does
 * not implement `Intl.supportedValuesOf`, rather than rendering an empty picker.
 */
const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Kyiv",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Cairo",
  "Africa/Lagos",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export function availableTimeZones(): readonly string[] {
  const intl: unknown = Intl;
  if (typeof intl === "object" && intl !== null && "supportedValuesOf" in intl) {
    const method = (intl as { readonly supportedValuesOf?: unknown }).supportedValuesOf;
    if (typeof method === "function") {
      const values: unknown = (method as (key: string) => unknown).call(Intl, "timeZone");
      if (Array.isArray(values)) {
        const zones = values.filter((value): value is string => typeof value === "string");
        if (zones.length > 0) return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
      }
    }
  }
  return FALLBACK_ZONES;
}

export interface ZonedRendering {
  readonly timeZone: string;
  /** `2026-08-31 15:05:00` — sortable, unambiguous, no locale-dependent month names. */
  readonly wallClock: string;
  /** `GMT+01:00`, as the runtime's tz database reports it for this instant. */
  readonly utcOffset: string;
  /** `BST`, `EDT`, `GMT+5:30` — whatever short name the zone uses at this instant. */
  readonly abbreviation: string;
}

function partsToRecord(parts: readonly Intl.DateTimeFormatPart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/**
 * Render an instant as a wall clock in one zone.
 *
 * The offset is read from the runtime's own tz database at that instant, so a timestamp in
 * July and one in January in the same zone correctly differ — which is exactly the mistake
 * that puts an event an hour out of position in a timeline.
 */
export function renderInZone(date: Date, timeZone: string): ToolResult<ZonedRendering> {
  try {
    const base = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const parts = partsToRecord(base);

    const offsetParts = partsToRecord(
      new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" }).formatToParts(date),
    );
    const shortParts = partsToRecord(
      new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(date),
    );

    // `hour: "2-digit"` with hour12:false renders midnight as 24 in some ICU versions.
    const hour = parts["hour"] === "24" ? "00" : (parts["hour"] ?? "00");

    return ok({
      timeZone,
      wallClock: `${parts["year"] ?? ""}-${parts["month"] ?? ""}-${parts["day"] ?? ""} ${hour}:${parts["minute"] ?? ""}:${parts["second"] ?? ""}`,
      utcOffset: offsetParts["timeZoneName"] ?? "unknown",
      abbreviation: shortParts["timeZoneName"] ?? "unknown",
    });
  } catch {
    return fail(`"${timeZone}" is not a time zone this browser knows.`);
  }
}
