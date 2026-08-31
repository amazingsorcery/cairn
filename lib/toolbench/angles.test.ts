import { describe, expect, it } from "vitest";

import { formatDdm, formatDecimal, formatDms, parseCoordinatePair } from "./angles";
import { parseAnyCoordinate, renderAllFormats } from "./coordinates";

describe("parsing the notations a reader will paste", () => {
  const greenwich = { latitude: 51.477928, longitude: -0.001545 };

  const written: Array<[string, string]> = [
    ["51.477928, -0.001545", "decimal degrees"],
    ["51.477928 -0.001545", "decimal degrees, space separated"],
    ["51 28 40.54 N, 0 0 5.56 W", "DMS with hemisphere letters"],
    ["51°28'40.54\"N 000°00'05.56\"W", "DMS with symbols"],
    ["N51 28.6757 W000 00.0927", "DDM with leading hemisphere letters"],
    ["51 28.6757 N, 0 0.0927 W", "DDM with trailing hemisphere letters"],
  ];

  for (const [input, label] of written) {
    it(`reads ${label}`, () => {
      const parsed = parseCoordinatePair(input);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) return;
      // 1e-5 degrees is about 1.1 m, which is finer than the input notations resolve.
      expect(parsed.value.latitude).toBeCloseTo(greenwich.latitude, 4);
      expect(parsed.value.longitude).toBeCloseTo(greenwich.longitude, 4);
    });
  }

  it("uses hemisphere letters to decide which value is which, not the order", () => {
    const parsed = parseCoordinatePair("W0.001545 N51.477928");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.latitude).toBeCloseTo(51.477928, 6);
    expect(parsed.value.longitude).toBeCloseTo(-0.001545, 6);
  });

  it("reports which notation it found", () => {
    expect(parseCoordinatePair("51.4779, -0.0015").ok && parseCoordinatePair("51.4779, -0.0015")).toMatchObject({
      value: { notation: "decimalDegrees" },
    });
    expect(parseCoordinatePair("51 28.6757 N, 0 0.0927 W")).toMatchObject({
      value: { notation: "degreesDecimalMinutes" },
    });
    expect(parseCoordinatePair("51 28 40.5 N, 0 0 5.5 W")).toMatchObject({
      value: { notation: "degreesMinutesSeconds" },
    });
  });
});

describe("refusals, where guessing would put a point in the wrong place", () => {
  it("refuses a value that is both S and negative", () => {
    const result = parseCoordinatePair("-33.87 S, 151.21 E");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("guessing which would be worse");
  });

  it("refuses two latitudes", () => {
    expect(parseCoordinatePair("51 N, 33 S").ok).toBe(false);
  });

  it("refuses one hemisphere letter without the other", () => {
    expect(parseCoordinatePair("51.4779 N, -0.0015").ok).toBe(false);
  });

  it("refuses out-of-range values", () => {
    expect(parseCoordinatePair("91, 0").ok).toBe(false);
    expect(parseCoordinatePair("0, 181").ok).toBe(false);
    expect(parseCoordinatePair("51 61.5 N, 0 0 W").ok).toBe(false);
  });
});

describe("formatting", () => {
  it("carries 59.999 seconds up into the next minute rather than printing 60", () => {
    // 51 + 28/60 + 59.999/3600 rounds to 60.00 seconds at two decimals.
    const value = 51 + 28 / 60 + 59.999 / 3600;
    expect(formatDms(value, "latitude")).toBe("51°29'00.00\"N");
  });

  it("pads longitude degrees to three digits, as a chart does", () => {
    expect(formatDms(-0.001545, "longitude")).toBe("000°00'05.56\"W");
    expect(formatDdm(-0.001545, "longitude")).toBe("000°00.0927'W");
  });

  it("does not print more decimal places than a coordinate can justify", () => {
    // Six places is about 0.11 m at the equator, already finer than consumer GPS.
    expect(formatDecimal(51.4779283333)).toBe("51.477928");
  });
});

describe("format detection across the whole coordinate tool", () => {
  it("tells MGRS, UTM, Plus Codes and angles apart", () => {
    const cases: Array<[string, string]> = [
      ["8FVC2222+22", "plusCode"],
      ["31N AA 66021 00000", "mgrs"],
      ["30U 699319 5706748", "utm"],
      ["51.477928, -0.001545", "decimalDegrees"],
      ["51 28 40.54 N, 0 0 5.56 W", "degreesMinutesSeconds"],
    ];
    for (const [input, expected] of cases) {
      const parsed = parseAnyCoordinate(input);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.detectedFormat, input).toBe(expected);
    }
  });

  it("reports the area a box notation actually named", () => {
    const coarse = parseAnyCoordinate("33T UM 15 28");
    expect(coarse.ok && coarse.value.areaMetres).toBe(1000);
    const point = parseAnyCoordinate("51.477928, -0.001545");
    expect(point.ok && point.value.areaMetres).toBe(0);
  });

  it("renders every format from one point, and agrees with itself on the way back", () => {
    const rendered = renderAllFormats(51.477928, -0.001545);
    expect(rendered.utm).not.toBeNull();
    expect(rendered.mgrs).not.toBeNull();
    expect(rendered.plusCode).not.toBeNull();
    expect(rendered.geoUri).toBe("geo:51.477928,-0.001545");

    for (const text of [rendered.utm, rendered.mgrs, rendered.plusCode, rendered.decimalDegrees]) {
      if (text === null) continue;
      const back = parseAnyCoordinate(text);
      expect(back.ok, text).toBe(true);
      if (!back.ok) continue;
      // Every notation here resolves to within a few metres of the original point.
      expect(back.value.latitude, text).toBeCloseTo(51.477928, 3);
      expect(back.value.longitude, text).toBeCloseTo(-0.001545, 3);
    }
  });

  it("reports grid convergence, which is not zero away from a central meridian", () => {
    // Zone 31's central meridian is 3E, so a point at 3E has no convergence and one near
    // the eastern edge of the zone has about atan(tan(2.9 deg) * sin(51.5 deg)) = 2.3 deg.
    expect(renderAllFormats(51.5, 3).gridConvergenceDegrees ?? 1).toBeCloseTo(0, 6);
    expect(renderAllFormats(51.5, 5.9).gridConvergenceDegrees ?? 0).toBeCloseTo(2.27, 1);
  });
});
