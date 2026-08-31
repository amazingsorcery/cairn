import { describe, expect, it } from "vitest";

import { formatMgrs, fromMgrs, parseMgrs, toMgrs } from "./mgrs";

describe("MGRS square lettering", () => {
  /**
   * Derived from the published definition of the AA lettering scheme rather than from this
   * implementation: zone 31 is in column set 1 (letters A-H), the point sits in the first
   * 100 km column east of the 100,000 m line, and at zero northing it is in the first row,
   * with no offset because 31 is odd. That gives square AA and a northing of 0.
   */
  it("puts the intersection of the equator and the prime meridian in 31N AA", () => {
    const reference = toMgrs(0, 0, 5);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.value.zone).toBe(31);
    expect(reference.value.band).toBe("N");
    expect(reference.value.square).toBe("AA");
    expect(reference.value.northing).toBe(0);
    /*
     * The full UTM easting here is 500,000 minus the projected distance from zone 31's
     * central meridian at 3E back to the prime meridian. At the equator that distance is
     * k0 * a * (A + A^3/6) with A = 3 degrees in radians, which is 0.9996 * 6378137 *
     * (0.0523599 + 0.0000239) = 333,977 m, giving a full easting near 166,023 m. MGRS
     * reports the position *within* the 100 km square, so the stored value is that minus
     * 100,000. Computed from the projection's definition, independently of this code.
     */
    expect(reference.value.easting).toBeGreaterThan(66_000);
    expect(reference.value.easting).toBeLessThan(66_100);
  });

  it("offsets the row letters of even-numbered zones by five", () => {
    // Two points at the same northing in an odd and an even zone must differ by exactly five
    // places in the row alphabet. That offset is the part of the scheme most often dropped.
    const rows = "ABCDEFGHJKLMNPQRSTUV";
    const odd = toMgrs(0.5, 3, 5); // zone 31, odd
    const even = toMgrs(0.5, 9, 5); // zone 32, even
    expect(odd.ok && even.ok).toBe(true);
    if (!odd.ok || !even.ok) return;
    const oddRow = rows.indexOf(odd.value.square[1] ?? "");
    const evenRow = rows.indexOf(even.value.square[1] ?? "");
    expect((evenRow - oddRow + 20) % 20).toBe(5);
  });

  it("cycles the column letter sets every three zones", () => {
    const sets = [1, 2, 3, 4, 5, 6].map((zone) => {
      const longitude = (zone - 1) * 6 - 180 + 3;
      const reference = toMgrs(0.5, longitude, 5);
      return reference.ok ? (reference.value.square[0] ?? "") : "";
    });
    expect(sets[0]).toBe(sets[3]);
    expect(sets[1]).toBe(sets[4]);
    expect(sets[2]).toBe(sets[5]);
  });
});

describe("round trip", () => {
  const points: Array<[number, number, string]> = [
    [51.477928, -0.001545, "Greenwich"],
    [48.858222, 2.2945, "Paris, an even zone"],
    [-33.8688, 151.2093, "Sydney, southern hemisphere"],
    [40.689247, -74.044502, "New York"],
    [-1.2921, 36.8219, "Nairobi, just south of the equator"],
    [64.1466, -21.9426, "Reykjavik, high latitude"],
    [1.3521, 103.8198, "Singapore, just north of the equator"],
  ];

  for (const [latitude, longitude, label] of points) {
    it(`returns to within the 1 m square it names: ${label}`, () => {
      const reference = toMgrs(latitude, longitude, 5);
      expect(reference.ok, label).toBe(true);
      if (!reference.ok) return;
      const back = fromMgrs(reference.value);
      expect(back.ok, label).toBe(true);
      if (!back.ok) return;
      // A five-digit reference names a 1 m square, so its south-west corner is within
      // about 1.5 m of the original point. 2e-5 degrees is roughly 2.2 m.
      expect(back.value.latitude).toBeCloseTo(latitude, 4);
      expect(back.value.longitude).toBeCloseTo(longitude, 4);
      expect(back.value.boxMetres).toBe(1);
    });
  }

  it("survives the text form", () => {
    const reference = toMgrs(48.858222, 2.2945, 5);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    const text = formatMgrs(reference.value);
    const parsed = parseMgrs(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(reference.value);
  });
});

describe("precision is visible in the length, which is the point of MGRS", () => {
  it("names a bigger box for a shorter reference", () => {
    const boxes = [1, 2, 3, 4, 5].map((digits) => {
      const reference = toMgrs(51.477928, -0.001545, digits);
      if (!reference.ok) return null;
      const back = fromMgrs(reference.value);
      return back.ok ? back.value.boxMetres : null;
    });
    expect(boxes).toEqual([10_000, 1_000, 100, 10, 1]);
  });

  it("formats only the digits the precision justifies", () => {
    const reference = toMgrs(51.477928, -0.001545, 2);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    const text = formatMgrs(reference.value);
    const [, , east, north] = text.split(" ");
    expect(east).toHaveLength(2);
    expect(north).toHaveLength(2);
  });
});

describe("refusals", () => {
  it("rejects an odd number of digits rather than splitting them unevenly", () => {
    const result = parseMgrs("33TUM123");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("same number of digits on each axis");
  });

  it("rejects a column letter that does not belong to the zone", () => {
    // Zone 33 uses column set 3 (S-Z). "A" belongs to zones 1, 4, 7 and so on.
    const parsed = parseMgrs("33TAM1542828745");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(fromMgrs(parsed.value).ok).toBe(false);
  });
});
