import { describe, expect, it } from "vitest";

import {
  bearingDifference,
  elevationForShadowRatio,
  shadowRatioForElevation,
  solarPosition,
  sunTimes,
  timesForShadowRatio,
} from "./sun";

/**
 * Checks the solar model against astronomical constants, not its own output. Tolerances
 * match suncalc's low-precision Meeus series (~1' of arc, ~1 min of time); not
 * ephemeris-grade.
 */

/** Earth's obliquity of the ecliptic, and therefore the solar declination at each solstice. */
const OBLIQUITY_DEGREES = 23.44;

/** Peak elevation reached at a latitude on a date, found by sampling the whole UTC day. */
function peakElevation(latitude: number, longitude: number, isoDate: string): number {
  let peak = -90;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const when = new Date(`${isoDate}T00:00:00Z`);
    when.setUTCMinutes(minute);
    peak = Math.max(peak, solarPosition(latitude, longitude, when).elevationDegrees);
  }
  return peak;
}

describe("the solstices put the sun overhead at the tropics", () => {
  it("reaches the zenith on the Tropic of Cancer at the June solstice", () => {
    // By definition, the sun is overhead on the Tropic of Cancer at the June solstice.
    expect(peakElevation(OBLIQUITY_DEGREES, 0, "2026-06-21")).toBeGreaterThan(89.5);
  });

  it("reaches the zenith on the Tropic of Capricorn at the December solstice", () => {
    expect(peakElevation(-OBLIQUITY_DEGREES, 0, "2026-12-21")).toBeGreaterThan(89.5);
  });

  it("gives the pole a day the sun does not set on", () => {
    const times = sunTimes(89, 0, new Date("2026-06-21T12:00:00Z"));
    expect(times.polarDay).toBe(true);
    expect(times.polarNight).toBe(false);
    const winter = sunTimes(89, 0, new Date("2026-12-21T12:00:00Z"));
    expect(winter.polarNight).toBe(true);
  });
});

describe("solar noon", () => {
  // Noon elevation = 90 - |latitude - declination|; at the solstice, declination = obliquity.
  it("matches 90 minus the latitude, minus the declination, at the June solstice", () => {
    const cases: Array<[number, number]> = [
      [51.4778, 90 - Math.abs(51.4778 - OBLIQUITY_DEGREES)],
      [0, 90 - Math.abs(0 - OBLIQUITY_DEGREES)],
      [-33.8688, 90 - Math.abs(-33.8688 - OBLIQUITY_DEGREES)],
    ];
    for (const [latitude, expected] of cases) {
      // Loose tolerance for per-minute sampling and declination drift over the day.
      expect(peakElevation(latitude, 0, "2026-06-21"), `latitude ${latitude}`).toBeCloseTo(
        expected,
        0,
      );
    }
  });

  it("puts the sun due south at noon from the northern mid-latitudes", () => {
    const times = sunTimes(51.4778, -0.0015, new Date("2026-06-21T12:00:00Z"));
    const position = solarPosition(51.4778, -0.0015, times.solarNoon);
    expect(position.azimuthDegrees).toBeCloseTo(180, 0);
  });

  it("puts the sun due north at noon from the southern mid-latitudes", () => {
    const times = sunTimes(-33.8688, 151.2093, new Date("2026-06-21T02:00:00Z"));
    const position = solarPosition(-33.8688, 151.2093, times.solarNoon);
    expect(bearingDifference(position.azimuthDegrees, 0)).toBeLessThan(1);
  });
});

describe("the equinox geometry", () => {
  it("puts sunrise close to due east and sunset close to due west", () => {
    // Slack covers the sun's movement between the equinox instant and local sunrise.
    const times = sunTimes(0, 0, new Date("2026-03-20T06:00:00Z"));
    expect(times.sunrise).not.toBeNull();
    expect(times.sunset).not.toBeNull();
    if (times.sunrise === null || times.sunset === null) return;
    expect(bearingDifference(solarPosition(0, 0, times.sunrise).azimuthDegrees, 90)).toBeLessThan(1.5);
    expect(bearingDifference(solarPosition(0, 0, times.sunset).azimuthDegrees, 270)).toBeLessThan(1.5);
  });

  it("makes the day about twelve hours long", () => {
    const times = sunTimes(0, 0, new Date("2026-03-20T06:00:00Z"));
    if (times.sunrise === null || times.sunset === null) throw new Error("no sunrise");
    const hours = (times.sunset.getTime() - times.sunrise.getTime()) / 3_600_000;
    // Slightly over 12h: rise/set use the upper limb with refraction (-0.833°).
    expect(hours).toBeGreaterThan(12);
    expect(hours).toBeLessThan(12.2);
  });

  it("agrees with suncalc's own rise and set times about where the horizon is", () => {
    // Position and times should agree to within ~0.5° (geometric vs apparent altitude);
    // this catches gross errors like a radians/degrees mix-up.
    const times = sunTimes(51.4778, -0.0015, new Date("2026-09-15T06:00:00Z"));
    if (times.sunrise === null || times.sunset === null) throw new Error("no sunrise");
    expect(
      Math.abs(solarPosition(51.4778, -0.0015, times.sunrise).elevationDegrees),
    ).toBeLessThan(0.6);
    expect(Math.abs(solarPosition(51.4778, -0.0015, times.sunset).elevationDegrees)).toBeLessThan(
      0.6,
    );
  });
});

describe("shadow geometry", () => {
  it("makes a shadow exactly as long as the object is tall at 45 degrees", () => {
    expect(shadowRatioForElevation(45)).toBeCloseTo(1, 12);
    expect(elevationForShadowRatio(1)).toBeCloseTo(45, 12);
  });

  it("is a proper inverse across the useful range", () => {
    for (const elevation of [1, 5, 10, 22.5, 45, 60, 80, 89]) {
      expect(elevationForShadowRatio(shadowRatioForElevation(elevation))).toBeCloseTo(elevation, 9);
    }
  });

  it("points the shadow directly away from the sun", () => {
    const position = solarPosition(51.4778, -0.0015, new Date("2026-06-21T10:00:00Z"));
    expect(position.shadowBearingDegrees).not.toBeNull();
    if (position.shadowBearingDegrees === null) return;
    expect(bearingDifference(position.shadowBearingDegrees, position.azimuthDegrees)).toBeCloseTo(
      180,
      6,
    );
  });

  it("reports no shadow when the sun is down", () => {
    const position = solarPosition(51.4778, -0.0015, new Date("2026-12-21T23:00:00Z"));
    expect(position.elevationDegrees).toBeLessThan(0);
    expect(position.shadowRatio).toBeNull();
    expect(position.shadowBearingDegrees).toBeNull();
  });
});

describe("the inverse: time of day from a shadow", () => {
  const latitude = 51.4778;
  const longitude = -0.0015;
  const day = new Date("2026-06-21T12:00:00Z");

  it("recovers the time that produced a ratio, to within a minute", () => {
    const truth = new Date("2026-06-21T09:30:00Z");
    const ratio = solarPosition(latitude, longitude, truth).shadowRatio;
    expect(ratio).not.toBeNull();
    if (ratio === null) return;

    const result = timesForShadowRatio(latitude, longitude, day, ratio);
    const recovered = result.matches.find(
      (match) => Math.abs(match.time.getTime() - truth.getTime()) < 60_000,
    );
    expect(recovered, JSON.stringify(result.matches.map((m) => m.time.toISOString()))).toBeDefined();
  });

  it("returns two candidates, one each side of solar noon", () => {
    const result = timesForShadowRatio(latitude, longitude, day, 1.0);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((match) => match.half).sort()).toEqual(["afternoon", "morning"]);
    // Symmetric about solar noon, so shadow length alone can't pick one.
    const noon = sunTimes(latitude, longitude, day).solarNoon.getTime();
    const [first, second] = result.matches;
    if (first === undefined || second === undefined) return;
    const offsets = [first, second].map((match) => Math.abs(match.time.getTime() - noon));
    expect(Math.abs((offsets[0] ?? 0) - (offsets[1] ?? 0))).toBeLessThan(120_000);
  });

  it("separates the two candidates by their shadow direction", () => {
    const result = timesForShadowRatio(latitude, longitude, day, 1.0);
    const [morning, afternoon] = result.matches;
    if (morning === undefined || afternoon === undefined) return;
    // Morning shadows point west of north here, afternoon shadows east.
    expect(bearingDifference(morning.shadowBearingDegrees, afternoon.shadowBearingDegrees)).
      toBeGreaterThan(30);
  });

  it("says a shadow is impossible rather than returning a plausible wrong time", () => {
    // A ratio of 0.1 needs the sun 84 degrees up. London never gets past about 62.
    const result = timesForShadowRatio(latitude, longitude, day, 0.1);
    expect(result.matches).toHaveLength(0);
    expect(result.unreachableReason).toContain("tops out at");
    expect(result.maximumElevationDegrees).toBeLessThan(63);
    expect(result.maximumElevationDegrees).toBeGreaterThan(61);
  });

  it("refuses a ratio that is not a positive number", () => {
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = timesForShadowRatio(latitude, longitude, day, ratio);
      expect(result.matches).toHaveLength(0);
      expect(result.unreachableReason).not.toBeNull();
    }
  });
});
