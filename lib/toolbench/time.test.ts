import { describe, expect, it } from "vitest";

import {
  FILETIME_UNIX_EPOCH,
  HFS_EPOCH_OFFSET,
  MAC_ABSOLUTE_EPOCH_OFFSET,
  WEBKIT_UNIX_EPOCH,
  availableTimeZones,
  guessFormats,
  parseTimestamp,
  renderInZone,
  toAllFormats,
} from "./time";

/**
 * The epoch offsets below are documented constants, not derived from this code:
 *
 *   116444736000000000  100 ns intervals from 1601-01-01 to 1970-01-01. The value Microsoft
 *                       documents for converting FILETIME to Unix time.
 *   978307200           seconds from 1970-01-01 to 2001-01-01. Apple's published
 *                       `kCFAbsoluteTimeIntervalSince1970`.
 *   2082844800          seconds from 1904-01-01 to 1970-01-01, the HFS/HFS+ epoch.
 */
describe("epoch anchors", () => {
  it("places the Unix epoch where each format says it is", () => {
    expect(FILETIME_UNIX_EPOCH).toBe(116_444_736_000_000_000n);
    expect(WEBKIT_UNIX_EPOCH).toBe(11_644_473_600_000_000n);
    expect(MAC_ABSOLUTE_EPOCH_OFFSET).toBe(978_307_200);
    expect(HFS_EPOCH_OFFSET).toBe(2_082_844_800);
  });

  it("decodes each epoch's own zero to its documented date", () => {
    const cases: Array<[Parameters<typeof parseTimestamp>[0], string, string]> = [
      ["unixSeconds", "0", "1970-01-01T00:00:00.000Z"],
      ["windowsFiletime", "0", "1601-01-01T00:00:00.000Z"],
      ["webkitMicroseconds", "0", "1601-01-01T00:00:00.000Z"],
      ["macAbsolute", "0", "2001-01-01T00:00:00.000Z"],
      ["hfsPlus", "0", "1904-01-01T00:00:00.000Z"],
    ];
    for (const [format, input, expected] of cases) {
      const parsed = parseTimestamp(format, input);
      expect(parsed.ok, format).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.date.toISOString(), format).toBe(expected);
    }
  });

  it("decodes the documented FILETIME for the Unix epoch", () => {
    const parsed = parseTimestamp("windowsFiletime", "116444736000000000");
    expect(parsed.ok && parsed.value.date.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("round trips through every format", () => {
  const instants = [
    "1970-01-01T00:00:00.000Z",
    "2001-01-01T00:00:00.000Z",
    "2026-08-31T14:05:09.000Z",
    "1985-04-12T23:20:50.000Z",
    "2099-12-31T23:59:58.000Z",
  ];

  for (const iso of instants) {
    it(`returns to ${iso}`, () => {
      const date = new Date(iso);
      const all = toAllFormats(date);
      const checks: Array<[Parameters<typeof parseTimestamp>[0], string]> = [
        ["unixSeconds", all.unixSeconds],
        ["unixMilliseconds", all.unixMilliseconds],
        ["iso8601", all.iso8601],
        ["windowsFiletime", all.windowsFiletime],
        ["webkitMicroseconds", all.webkitMicroseconds],
        ["macAbsolute", all.macAbsolute],
        ["hfsPlus", all.hfsPlus],
      ];
      for (const [format, value] of checks) {
        const parsed = parseTimestamp(format, value);
        expect(parsed.ok, `${format} ${value}`).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.value.date.getTime(), format).toBe(date.getTime());
      }
    });
  }
});

describe("MS-DOS packed date-time", () => {
  /**
   * Bit layout from the FAT specification. Worked by hand for 2026-08-31 14:05:08:
   *
   *   year 2026 - 1980 = 46 -> 0b0101110, month 8 -> 0b1000, day 31 -> 0b11111
   *   date word = (46 << 9) | (8 << 5) | 31 = 23552 + 256 + 31 = 23839 = 0x5D1F
   *   hour 14 -> 0b01110, minute 5 -> 0b000101, second 8/2 = 4 -> 0b00100
   *   time word = (14 << 11) | (5 << 5) | 4 = 28672 + 160 + 4 = 28836 = 0x70A4
   */
  it("decodes a hand-computed value", () => {
    const parsed = parseTimestamp("dosDateTime", "0x5D1F70A4");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.date.toISOString()).toBe("2026-08-31T14:05:08.000Z");
  });

  it("encodes it back", () => {
    expect(toAllFormats(new Date("2026-08-31T14:05:08.000Z")).dosDateTime).toBe("0x5d1f70a4");
  });

  it("loses the odd second, because the format has two-second resolution", () => {
    const parsed = parseTimestamp(
      "dosDateTime",
      toAllFormats(new Date("2026-08-31T14:05:09.000Z")).dosDateTime,
    );
    expect(parsed.ok && parsed.value.date.toISOString()).toBe("2026-08-31T14:05:08.000Z");
  });

  it("says so rather than encoding a date the format cannot hold", () => {
    expect(toAllFormats(new Date("1979-12-31T00:00:00Z")).dosDateTime).toContain("out of range");
  });

  it("refuses bits that do not form a date", () => {
    // Month 15 does not exist; a byte-order mistake produces exactly this.
    const result = parseTimestamp("dosDateTime", "0x5DFF70A4");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("little-endian");
  });
});

describe("sub-millisecond precision is reported, not silently dropped", () => {
  it("names the discarded 100 ns ticks of a FILETIME", () => {
    // The Unix epoch plus one second and 1234 ticks of 100 ns.
    const ticks = FILETIME_UNIX_EPOCH + 10_000_000n + 1234n;
    const parsed = parseTimestamp("windowsFiletime", String(ticks));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.date.toISOString()).toBe("1970-01-01T00:00:01.000Z");
    expect(parsed.value.discardedSubMillisecond).toBe("1234 x 100 ns");
  });

  it("names the discarded microseconds of a WebKit timestamp", () => {
    const parsed = parseTimestamp("webkitMicroseconds", String(WEBKIT_UNIX_EPOCH + 1_000_567n));
    expect(parsed.ok && parsed.value.discardedSubMillisecond).toBe("567 us");
  });
});

describe("guessing an unlabelled number", () => {
  it("prefers FILETIME for a value that is nonsense as Unix seconds", () => {
    // 133200000000000000 ticks is 2023 as a FILETIME and four billion years away as seconds.
    const guesses = guessFormats("133200000000000000");
    const plausible = guesses.filter((guess) => guess.plausible);
    expect(plausible.map((guess) => guess.format)).toContain("windowsFiletime");
    expect(plausible[0]?.instant.date.getUTCFullYear()).toBe(2023);
  });

  it("offers both readings when a value is plausible either way", () => {
    // 1500000000 is mid-2017 as Unix seconds and mid-1917 as HFS+ seconds — the latter is
    // outside the plausible window, so only one survives. 2900000000 is 2061 as seconds and
    // 1995 as HFS+ seconds, and both are believable, so both are offered.
    const guesses = guessFormats("2900000000").filter((guess) => guess.plausible);
    expect(guesses.map((guess) => guess.format)).toEqual(
      expect.arrayContaining(["unixSeconds", "hfsPlus"]),
    );
  });

  it("puts implausible readings last rather than hiding them", () => {
    const guesses = guessFormats("1756648800");
    expect(guesses.length).toBeGreaterThan(1);
    expect(guesses[0]?.plausible).toBe(true);
    expect(guesses[guesses.length - 1]?.plausible).toBe(false);
  });
});

describe("time zones", () => {
  it("offers a list that includes UTC first", () => {
    const zones = availableTimeZones();
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("Europe/London");
    expect(zones.length).toBeGreaterThan(10);
  });

  it("applies the offset in force at that instant, not a fixed one", () => {
    // The whole point: London is UTC+0 in January and UTC+1 in July. A converter that uses
    // one offset all year puts half a timeline an hour out.
    const winter = renderInZone(new Date("2026-01-15T12:00:00Z"), "Europe/London");
    const summer = renderInZone(new Date("2026-07-15T12:00:00Z"), "Europe/London");
    expect(winter.ok && winter.value.wallClock).toBe("2026-01-15 12:00:00");
    expect(summer.ok && summer.value.wallClock).toBe("2026-07-15 13:00:00");
    expect(winter.ok && winter.value.utcOffset).toBe("GMT");
    expect(summer.ok && summer.value.utcOffset).toBe("GMT+01:00");
  });

  it("renders midnight as 00, not 24", () => {
    const rendered = renderInZone(new Date("2026-03-04T00:00:00Z"), "UTC");
    expect(rendered.ok && rendered.value.wallClock).toBe("2026-03-04 00:00:00");
  });

  it("crosses the date line correctly", () => {
    const rendered = renderInZone(new Date("2026-03-04T22:00:00Z"), "Pacific/Auckland");
    expect(rendered.ok && rendered.value.wallClock.startsWith("2026-03-05")).toBe(true);
  });

  it("refuses a zone it does not know", () => {
    expect(renderInZone(new Date(), "Mars/Olympus_Mons").ok).toBe(false);
  });
});
