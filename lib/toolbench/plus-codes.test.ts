import { describe, expect, it } from "vitest";

import { decodePlusCode, encodePlusCode, isFullPlusCode } from "./plus-codes";

/**
 * The values below are derived from the Open Location Code specification's own arithmetic,
 * not from this implementation. Worked by hand for `8FVC2222+22`:
 *
 *   latitude 47 + 90 = 137. First pair digit: floor(137 / 20) = 6, alphabet[6] = "8",
 *   remainder 17. Second: floor(17 / 1) = 17, alphabet[17] = "V". Remainder 0, so every
 *   later latitude digit is alphabet[0] = "2".
 *   longitude 8 + 180 = 188. First: floor(188 / 20) = 9, alphabet[9] = "F", remainder 8.
 *   Second: floor(8 / 1) = 8, alphabet[8] = "C". Remainder 0, so the rest are "2".
 *
 *   Interleaved latitude-first: 8 F V C 2 2 2 2 + 2 2.
 */
describe("the specification's arithmetic", () => {
  it("encodes 47N 8E as 8FVC2222+22", () => {
    expect(encodePlusCode(47, 8, 10)).toEqual({ ok: true, value: "8FVC2222+22" });
  });

  it("decodes 8FVC2222+22 back to the box whose corner is 47N 8E", () => {
    const area = decodePlusCode("8FVC2222+22");
    expect(area.ok).toBe(true);
    if (!area.ok) return;
    expect(area.value.latitudeLow).toBeCloseTo(47, 9);
    expect(area.value.longitudeLow).toBeCloseTo(8, 9);
    // A ten-digit code is 1/8000 of a degree on each side.
    expect(area.value.latitudeHigh - area.value.latitudeLow).toBeCloseTo(0.000125, 12);
    expect(area.value.longitudeHigh - area.value.longitudeLow).toBeCloseTo(0.000125, 12);
  });

  it("uses the 20-character alphabet with no vowels and no digit lookalikes", () => {
    const code = encodePlusCode(51.477928, -0.001545, 11);
    expect(code.ok).toBe(true);
    if (!code.ok) return;
    expect(code.value).toMatch(/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{3}$/);
    // No vowels means no code can accidentally spell a word.
    expect(code.value).not.toMatch(/[AEIOU]/);
  });
});

describe("code length and the area it names", () => {
  const cases: Array<[number, number]> = [
    // [code length, approximate box height in metres]
    [2, 20 * 111_320],
    [4, 1 * 111_320],
    [6, 0.05 * 111_320],
    [8, 0.0025 * 111_320],
    [10, 0.000125 * 111_320],
    [11, (0.000125 / 5) * 111_320],
  ];

  for (const [length, expectedMetres] of cases) {
    it(`a ${length}-digit code names a box about ${Math.round(expectedMetres)} m tall`, () => {
      const code = encodePlusCode(51.477928, -0.001545, length);
      expect(code.ok).toBe(true);
      if (!code.ok) return;
      const area = decodePlusCode(code.value);
      expect(area.ok).toBe(true);
      if (!area.ok) return;
      expect(area.value.boxHeightMetres).toBeCloseTo(expectedMetres, 0);
    });
  }

  it("pads a short code rather than producing a code that decodes elsewhere", () => {
    const code = encodePlusCode(51.477928, -0.001545, 4);
    expect(code.ok && code.value).toMatch(/^[^0]{4}0000\+$/);
  });
});

describe("round trip", () => {
  const points: Array<[number, number, string]> = [
    [51.477928, -0.001545, "Greenwich"],
    [-33.8688, 151.2093, "Sydney"],
    [0, 0, "equator and prime meridian"],
    [-89.9, -179.9, "the far south-west corner"],
    [89.9, 179.9, "the far north-east corner"],
    [47, 8, "a point exactly on a box boundary"],
  ];

  for (const [latitude, longitude, label] of points) {
    it(`contains the point it was made from: ${label}`, () => {
      const code = encodePlusCode(latitude, longitude, 11);
      expect(code.ok, label).toBe(true);
      if (!code.ok) return;
      const area = decodePlusCode(code.value);
      expect(area.ok, label).toBe(true);
      if (!area.ok) return;
      expect(latitude).toBeGreaterThanOrEqual(area.value.latitudeLow);
      expect(latitude).toBeLessThanOrEqual(area.value.latitudeHigh);
      expect(longitude).toBeGreaterThanOrEqual(area.value.longitudeLow);
      expect(longitude).toBeLessThanOrEqual(area.value.longitudeHigh);
    });
  }

  it("puts the north pole inside a box rather than on the edge of none", () => {
    const code = encodePlusCode(90, 0, 10);
    expect(code.ok).toBe(true);
    if (!code.ok) return;
    const area = decodePlusCode(code.value);
    expect(area.ok && area.value.latitudeHigh).toBeLessThanOrEqual(90);
  });
});

describe("refusals", () => {
  it("rejects a shortened code and says why it cannot be resolved", () => {
    const result = decodePlusCode("QCJ+2VX");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("shortened");
  });

  it("rejects a code with a letter outside the alphabet", () => {
    expect(isFullPlusCode("8FVA2222+22")).toBe(false);
    expect(decodePlusCode("8FVA2222+22").ok).toBe(false);
  });

  it("rejects an odd code length below ten", () => {
    expect(encodePlusCode(47, 8, 5).ok).toBe(false);
  });
});
