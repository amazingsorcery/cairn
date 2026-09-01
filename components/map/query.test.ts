import { describe, expect, it } from "vitest";

import { QUERY_GRID_DEGREES, normaliseSourceQuery, sourceQueryKey } from "./query";

/**
 * The grid the map's cache key and the client's throttle both stand on.
 *
 * Two properties matter and they pull against each other: the key must never be **coarser**
 * than the question (that is QV-04 — one reader's bounding box served to the next as fresh
 * global data), and it must never be so **fine** that ordinary map noise gives every reader
 * their own upstream call. The tests below pin both ends.
 */

const LONDON = { bbox: { west: -0.6, south: 51.2, east: 0.4, north: 51.7 } };

describe("normaliseSourceQuery", () => {
  it("snaps outward, so the normalised box contains the box that was asked about", () => {
    const { bbox } = normaliseSourceQuery(LONDON);
    expect(bbox).toEqual({ west: -1, south: 51, east: 1, north: 52 });
  });

  it("is idempotent, so a value that has been through it once is unchanged", () => {
    const once = normaliseSourceQuery(LONDON);
    expect(normaliseSourceQuery(once)).toEqual(once);
  });

  it("never collapses a box to zero area, however far the reader has zoomed in", () => {
    /*
     * Nearest-rounding turned a sub-degree viewport into a zero-area box, which
     * `viewportFromBbox` turns into a 1 nm circle — an empty table that looks like an honest
     * answer. Silent incompleteness is the failure this codebase keeps meeting; the
     * normalisation must not be able to cause it.
     */
    const tight = normaliseSourceQuery({
      bbox: { west: 0.1, south: 51.1, east: 0.4, north: 51.4 },
    });
    expect(tight.bbox).toBeDefined();
    if (!tight.bbox) return;
    expect(tight.bbox.east - tight.bbox.west).toBeGreaterThanOrEqual(QUERY_GRID_DEGREES);
    expect(tight.bbox.north - tight.bbox.south).toBeGreaterThanOrEqual(QUERY_GRID_DEGREES);
  });

  it("clamps to the coordinate system rather than snapping past it", () => {
    const { bbox } = normaliseSourceQuery({
      bbox: { west: -179.8, south: -84.9, east: 179.8, north: 84.9 },
    });
    expect(bbox).toEqual({ west: -180, south: -85, east: 180, north: 85 });
  });

  it("drops a box it cannot read rather than guessing at one", () => {
    /* Non-finite, inverted, and zero-width: none is a rectangle this pipeline can answer. */
    expect(normaliseSourceQuery({ bbox: { west: NaN, south: 0, east: 1, north: 1 } }).bbox).toBeUndefined();
    expect(normaliseSourceQuery({ bbox: { west: 10, south: 0, east: 5, north: 1 } }).bbox).toBeUndefined();
    expect(normaliseSourceQuery({ bbox: { west: 5, south: 0, east: 5, north: 1 } }).bbox).toBeUndefined();
  });

  it("carries the limit through untouched", () => {
    expect(normaliseSourceQuery({ limit: 50 })).toEqual({ limit: 50 });
    expect(normaliseSourceQuery({ ...LONDON, limit: 50 }).limit).toBe(50);
  });
});

describe("sourceQueryKey", () => {
  it("gives two genuinely different viewports two keys", () => {
    const tokyo = sourceQueryKey({ bbox: { west: 139, south: 35, east: 141, north: 36 } });
    const london = sourceQueryKey({ bbox: { west: -1, south: 51, east: 1, north: 52 } });
    expect(tokyo).not.toBe(london);
  });

  it("gives two trivially different viewports one key", () => {
    expect(sourceQueryKey(LONDON)).toBe(
      sourceQueryKey({ bbox: { west: -0.9, south: 51.05, east: 0.1, north: 51.95 } }),
    );
  });

  it("distinguishes a bounded question from an unbounded one", () => {
    /* `unscoped` is not "the world": for a source with a configured area it means that area. */
    expect(sourceQueryKey({})).toBe("unscoped");
    expect(sourceQueryKey(LONDON)).not.toBe("unscoped");
  });

  it("distinguishes two limits on the same box", () => {
    expect(sourceQueryKey({ ...LONDON, limit: 10 })).not.toBe(sourceQueryKey({ ...LONDON, limit: 20 }));
  });

  it("does not let a negative zero produce a second key for one box", () => {
    expect(sourceQueryKey({ bbox: { west: -0.4, south: -0.4, east: 1, north: 1 } })).toBe(
      sourceQueryKey({ bbox: { west: -1, south: -1, east: 1, north: 1 } }),
    );
    expect(sourceQueryKey({ bbox: { west: 0, south: 0, east: 0.2, north: 0.2 } })).not.toContain(
      "-0",
    );
  });
});
