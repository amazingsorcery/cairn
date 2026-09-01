import { describe, expect, it } from "vitest";

import {
  checkCoverage,
  daysBetween,
  findImageryLayer,
  GIBS_ACKNOWLEDGEMENT,
  GIBS_ENDPOINT,
  IMAGERY_LAYERS,
  imageryTileTemplate,
  metresPerPixel,
  parseIsoDate,
  REFERENCE_LAYERS,
  referenceTileTemplate,
  shiftIsoDate,
  toIsoDate,
} from "./imagery";

describe("tile URL templates", () => {
  /**
   * Asserted against a URL that was fetched and returned `200 image/jpeg` on 2026-09-01,
   * written out here in full rather than assembled from the same function under test. A
   * template test that builds the expected string with the same code proves only that the
   * code is consistent with itself.
   */
  it("matches a URL confirmed against the live service", () => {
    const layer = findImageryLayer("MODIS_Terra_CorrectedReflectance_TrueColor");
    expect(layer).not.toBeNull();
    if (!layer) return;

    expect(imageryTileTemplate(layer, "2026-08-20")).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor" +
        "/default/2026-08-20/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    );
  });

  /**
   * WMTS orders the path TileMatrix/TileRow/TileCol, which is z/y/x. Transposing it returns
   * a valid tile of a DIFFERENT PLACE rather than an error, so the mistake renders as a
   * plausible map of somewhere else and can survive review.
   */
  it("puts the row before the column, as WMTS requires", () => {
    const layer = IMAGERY_LAYERS[0];
    expect(layer).toBeDefined();
    if (!layer) return;
    const template = imageryTileTemplate(layer, "2026-08-20");
    expect(template.indexOf("{y}")).toBeLessThan(template.indexOf("{x}"));
    expect(template).not.toContain("{z}/{x}/{y}");
  });

  it("omits the date segment for reference layers, which carry no time dimension", () => {
    const coastlines = REFERENCE_LAYERS.find((layer) => layer.id === "Coastlines_15m");
    expect(coastlines).toBeDefined();
    if (!coastlines) return;
    expect(referenceTileTemplate(coastlines)).toBe(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Coastlines_15m" +
        "/default/GoogleMapsCompatible_Level13/{z}/{y}/{x}.png",
    );
  });

  it("contacts exactly one origin", () => {
    for (const layer of IMAGERY_LAYERS) {
      expect(imageryTileTemplate(layer, "2026-08-20").startsWith(GIBS_ENDPOINT), layer.id).toBe(true);
    }
    for (const layer of REFERENCE_LAYERS) {
      expect(referenceTileTemplate(layer).startsWith(GIBS_ENDPOINT), layer.id).toBe(true);
    }
  });
});

describe("the layer catalogue", () => {
  it("has a unique id per layer and a plausible coverage window", () => {
    const ids = IMAGERY_LAYERS.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const layer of IMAGERY_LAYERS) {
      expect(parseIsoDate(layer.earliest).ok, layer.id).toBe(true);
      if (layer.latest !== null) {
        expect(parseIsoDate(layer.latest).ok, layer.id).toBe(true);
        expect(layer.latest > layer.earliest, layer.id).toBe(true);
      }
      expect(layer.whatItShows.length, layer.id).toBeGreaterThan(40);
      expect(layer.maxNativeZoom, layer.id).toBeGreaterThan(0);
    }
  });

  /**
   * Launch dates, as a sanity check that the catalogue was read and not remembered: Terra's
   * MODIS imagery starts in February 2000, Aqua's in July 2002, Suomi NPP's VIIRS in 2015
   * and NOAA-20's in 2018. Each layer's `earliest` is the first date GIBS itself declares.
   */
  it("orders the platforms by first coverage, oldest first within true colour", () => {
    const terra = findImageryLayer("MODIS_Terra_CorrectedReflectance_TrueColor");
    const aqua = findImageryLayer("MODIS_Aqua_CorrectedReflectance_TrueColor");
    const snpp = findImageryLayer("VIIRS_SNPP_CorrectedReflectance_TrueColor");
    const noaa20 = findImageryLayer("VIIRS_NOAA20_CorrectedReflectance_TrueColor");
    expect(terra?.earliest).toBe("2000-02-24");
    expect(aqua?.earliest).toBe("2002-07-03");
    expect(snpp?.earliest).toBe("2015-11-24");
    expect(noaa20?.earliest).toBe("2018-01-05");
  });

  /**
   * The night-lights layer stopped being produced. Presenting it as current would be the
   * silent-incompleteness failure; the end date is data, and the UI reads it.
   */
  it("records that the night-lights layer's coverage has ended", () => {
    const dnb = findImageryLayer("VIIRS_SNPP_DayNightBand_ENCC");
    expect(dnb?.latest).toBe("2023-07-07");
  });

  it("carries the acknowledgement GIBS asks for, verbatim", () => {
    expect(GIBS_ACKNOWLEDGEMENT).toContain("Global Imagery Browse Services");
    expect(GIBS_ACKNOWLEDGEMENT).toContain("ESDIS");
  });
});

describe("dates", () => {
  it("accepts a real date and normalises it", () => {
    const result = parseIsoDate(" 2026-08-20 ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("2026-08-20");
  });

  /**
   * `new Date("2023-02-29")` yields 1 March rather than failing. A tool that trusted it
   * would request a different day than the reader asked for and then label the result with
   * the day they asked for — which on a before-and-after comparison is the entire finding.
   */
  it("refuses a date that does not exist, which the Date constructor accepts", () => {
    expect(parseIsoDate("2023-02-29").ok).toBe(false);
    expect(parseIsoDate("2026-13-01").ok).toBe(false);
    expect(parseIsoDate("2026-04-31").ok).toBe(false);
    // 2024 is a leap year; 2023 and 2100 are not, 2000 is.
    expect(parseIsoDate("2024-02-29").ok).toBe(true);
    expect(parseIsoDate("2100-02-29").ok).toBe(false);
    expect(parseIsoDate("2000-02-29").ok).toBe(true);
  });

  it("refuses text that is not a date at all", () => {
    expect(parseIsoDate("yesterday").ok).toBe(false);
    expect(parseIsoDate("20/08/2026").ok).toBe(false);
    expect(parseIsoDate("").ok).toBe(false);
  });

  it("shifts across month, year and leap boundaries", () => {
    const cases: readonly (readonly [string, number, string])[] = [
      ["2026-08-20", 1, "2026-08-21"],
      ["2026-08-31", 1, "2026-09-01"],
      ["2026-01-01", -1, "2025-12-31"],
      ["2024-02-28", 1, "2024-02-29"],
      ["2023-02-28", 1, "2023-03-01"],
      ["2024-03-01", -1, "2024-02-29"],
      ["2026-03-15", -365, "2025-03-15"],
    ];
    for (const [from, days, expected] of cases) {
      const result = shiftIsoDate(from, days);
      expect(result.ok, `${from} ${days}`).toBe(true);
      if (result.ok) expect(result.value, `${from} ${days}`).toBe(expected);
    }
  });

  it("counts whole days between two dates, in both directions", () => {
    const forward = daysBetween("2026-08-20", "2026-09-01");
    expect(forward.ok).toBe(true);
    if (forward.ok) expect(forward.value).toBe(12);

    const backward = daysBetween("2026-09-01", "2026-08-20");
    expect(backward.ok).toBe(true);
    if (backward.ok) expect(backward.value).toBe(-12);

    // Across a leap day: 2024-02-28 to 2024-03-01 is two days, not one.
    const leap = daysBetween("2024-02-28", "2024-03-01");
    expect(leap.ok).toBe(true);
    if (leap.ok) expect(leap.value).toBe(2);
  });

  it("renders a Date as the UTC calendar day, because GIBS dates are UTC days", () => {
    expect(toIsoDate(new Date("2026-08-20T23:30:00Z"))).toBe("2026-08-20");
    expect(toIsoDate(new Date("2026-08-21T00:30:00Z"))).toBe("2026-08-21");
  });
});

describe("coverage checks", () => {
  const terra = findImageryLayer("MODIS_Terra_CorrectedReflectance_TrueColor");
  const dnb = findImageryLayer("VIIRS_SNPP_DayNightBand_ENCC");

  it("passes a date inside coverage", () => {
    expect(terra).not.toBeNull();
    if (!terra) return;
    expect(checkCoverage(terra, "2020-06-01", "2026-09-01").problem).toBeNull();
  });

  /**
   * Refused, not clamped. Clamping would render the nearest available day under the label of
   * the day the reader asked for, and the point of a two-date comparison is that both dates
   * are the dates you believe they are.
   */
  it("refuses a date before the platform existed, and says which date is the boundary", () => {
    expect(terra).not.toBeNull();
    if (!terra) return;
    const check = checkCoverage(terra, "1999-01-01", "2026-09-01");
    expect(check.problem).not.toBeNull();
    expect(check.problem).toContain("2000-02-24");
  });

  it("refuses a future date and says the imagery is not there yet", () => {
    expect(terra).not.toBeNull();
    if (!terra) return;
    const check = checkCoverage(terra, "2027-01-01", "2026-09-01");
    expect(check.problem).toContain("future");
  });

  it("refuses a date after a discontinued layer stopped, and says it stopped", () => {
    expect(dnb).not.toBeNull();
    if (!dnb) return;
    const check = checkCoverage(dnb, "2025-01-01", "2026-09-01");
    expect(check.problem).toContain("2023-07-07");
    expect(check.problem).toContain("no longer");
  });

  it("passes an invalid date's own error through rather than a generic one", () => {
    expect(terra).not.toBeNull();
    if (!terra) return;
    expect(checkCoverage(terra, "2023-02-29", "2026-09-01").problem).toContain("not a real date");
  });
});

describe("ground resolution", () => {
  /**
   * Web Mercator's published zoom-0 resolution is 156543.03392 m/px at the equator on a
   * 256-pixel tile, halving each level. At zoom 9 that is ~305.7 m — which is exactly the
   * value the GIBS tile matrix's own scale denominator gives for
   * GoogleMapsCompatible_Level9 (1091957.5469 x 0.00028 m = 305.7 m), so the catalogue's
   * `metresPerPixel` and this function are two independent routes to the same number.
   */
  it("matches the GIBS tile matrix's own scale denominator at the deepest zoom", () => {
    expect(metresPerPixel(9, 0)).toBeCloseTo(1_091_957.546931089 * 0.00028, 1);
    expect(metresPerPixel(9, 0)).toBeCloseTo(305.7, 1);
    expect(metresPerPixel(8, 0)).toBeCloseTo(611.5, 1);
  });

  it("shrinks with latitude, as Mercator requires", () => {
    expect(metresPerPixel(9, 60)).toBeCloseTo(metresPerPixel(9, 0) / 2, 0);
  });
});
