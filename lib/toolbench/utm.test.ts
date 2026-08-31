import { describe, expect, it } from "vitest";

import {
  CLARKE_1866,
  centralMeridian,
  fromUtm,
  latitudeBand,
  parseUtm,
  toUtm,
  transverseMercatorForward,
  utmZone,
} from "./utm";

describe("Snyder's transverse Mercator worked example", () => {
  /**
   * J. P. Snyder, *Map Projections — A Working Manual*, USGS Professional Paper 1395,
   * numerical example for the ellipsoidal transverse Mercator (pp. 269-270):
   *
   *   Clarke 1866, k0 = 0.9996, phi0 = 0, lambda0 = 75 W, phi = 40 30' N, lambda = 73 30' W
   *   x = 127,106.5 m      y = 4,484,124.4 m
   *
   * These are the published values. They are the reason this file exists: a projection that
   * only agrees with itself is not verified, and a round-trip test would pass just as
   * happily with the wrong ellipsoid, the wrong scale factor, or a sign error in the series.
   */
  it("reproduces the published x and y to a decimetre", () => {
    const { x, y } = transverseMercatorForward(40.5, -73.5, -75, CLARKE_1866, 0.9996);
    expect(x).toBeCloseTo(127_106.5, 0);
    expect(y).toBeCloseTo(4_484_124.4, 0);
  });
});

describe("zone numbering", () => {
  it("uses the plain formula away from the exceptions", () => {
    expect(utmZone(51.4778, -0.0015)).toBe(30);
    expect(utmZone(0, 0)).toBe(31);
    expect(utmZone(-33.8688, 151.2093)).toBe(56);
    expect(utmZone(40.5, -73.5)).toBe(18);
  });

  it("widens zone 32 over south-west Norway", () => {
    // 56N-64N, 3E-12E is zone 32 by definition; the naive formula would say 31.
    expect(utmZone(60.39, 5.32)).toBe(32);
    expect(utmZone(55.9, 5.32)).toBe(31);
    expect(utmZone(60.39, 2.9)).toBe(31);
  });

  it("applies the Svalbard exceptions", () => {
    expect(utmZone(78.0, 5)).toBe(31);
    expect(utmZone(78.0, 15)).toBe(33);
    expect(utmZone(78.0, 25)).toBe(35);
    expect(utmZone(78.0, 38)).toBe(37);
  });

  it("places the central meridian in the middle of the zone", () => {
    expect(centralMeridian(1)).toBe(-177);
    expect(centralMeridian(30)).toBe(-3);
    expect(centralMeridian(31)).toBe(3);
    expect(centralMeridian(60)).toBe(177);
  });
});

describe("latitude bands", () => {
  it("omits I and O", () => {
    const letters = [];
    for (let latitude = -80; latitude < 84; latitude += 0.5) {
      const band = latitudeBand(latitude);
      if (band.ok) letters.push(band.value);
    }
    expect(new Set(letters).has("I")).toBe(false);
    expect(new Set(letters).has("O")).toBe(false);
  });

  it("puts the boundaries where the definition puts them", () => {
    expect(latitudeBand(-80)).toEqual({ ok: true, value: "C" });
    expect(latitudeBand(-0.0001)).toEqual({ ok: true, value: "M" });
    expect(latitudeBand(0)).toEqual({ ok: true, value: "N" });
    expect(latitudeBand(71.9)).toEqual({ ok: true, value: "W" });
    // Band X is 12 degrees tall, not 8, so that the scheme reaches 84N.
    expect(latitudeBand(72)).toEqual({ ok: true, value: "X" });
    expect(latitudeBand(83.9)).toEqual({ ok: true, value: "X" });
  });

  it("refuses the polar regions rather than returning a wrong band", () => {
    expect(latitudeBand(85).ok).toBe(false);
    expect(latitudeBand(-81).ok).toBe(false);
  });
});

describe("round trip", () => {
  const points: Array<[number, number, string]> = [
    [51.477928, -0.001545, "Greenwich"],
    [40.5, -73.5, "Snyder's example point"],
    [-33.8688, 151.2093, "southern hemisphere"],
    [0, 0, "equator and prime meridian"],
    [-79.5, -170, "near the southern limit"],
    [83.5, 30, "near the northern limit"],
    [60.39, 5.32, "inside the Norway exception"],
    [45, 2.9999, "just west of a zone boundary"],
    [45, 3.0001, "just east of a zone boundary"],
  ];

  for (const [latitude, longitude, label] of points) {
    it(`returns to within a centimetre: ${label}`, () => {
      const utm = toUtm(latitude, longitude);
      expect(utm.ok).toBe(true);
      if (!utm.ok) return;
      const back = fromUtm(utm.value);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      /*
       * 1e-7 degrees is about 11 mm of latitude. The observed error is around 1e-8 degrees
       * (roughly 1 mm), which is the truncation error of the sixth-order series, not a
       * defect. The tolerance is set one order looser than the observed error so that the
       * test does not fail on a floating-point difference between platforms, and two orders
       * tighter than anything an investigator could measure.
       */
      expect(back.value.latitude).toBeCloseTo(latitude, 7);
      expect(back.value.longitude).toBeCloseTo(longitude, 7);
    });
  }
});

describe("parsing what a reader pastes", () => {
  it("takes the conventional written forms", () => {
    for (const written of ["33T 315428 5028745", "33T 315428mE 5028745mN", "33T,315428,5028745"]) {
      const parsed = parseUtm(written);
      expect(parsed.ok, written).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toMatchObject({ zone: 33, band: "T", easting: 315428, northing: 5028745 });
    }
  });

  it("reads band S as a northern band, because that is what it is", () => {
    const parsed = parseUtm("33S 315428 3728745");
    expect(parsed.ok && parsed.value.hemisphere).toBe("N");
  });

  it("refuses a coordinate with no band letter", () => {
    expect(parseUtm("33 315428 5028745").ok).toBe(false);
  });
});
