import { describe, expect, it } from "vitest";

import {
  boundingBoxAreaKm2,
  buildQuery,
  canonicaliseQuery,
  checkBoundingBox,
  DEFAULT_RESULT_LIMIT,
  FEATURE_PRESETS,
  formatBoundingBox,
  MAX_BBOX_AREA_KM2,
  MAX_RESULT_LIMIT,
  normaliseOverpass,
  parseBoundingBox,
  parseGuardedQuery,
  PRESET_GROUPS,
  QUERY_MAXSIZE_BYTES,
  QUERY_TIMEOUT_SECONDS,
  queryFromPresets,
  type BoundingBox,
} from "./overpass";

/** A ~12 x 8 km box over central London. Small enough to be a legitimate query. */
const LONDON: BoundingBox = { south: 51.47, west: -0.16, north: 51.54, east: 0.01 };

describe("bounding box area", () => {
  /**
   * The whole sphere is 4πR². This is the check that the formula is a spherical area and not
   * a degree rectangle: a naive Δlat × Δlon would give 360 × 180 = 64,800 "square degrees"
   * and no way to compare it against a kilometre limit at all.
   */
  it("integrates to the surface area of the sphere over the whole globe", () => {
    const radius = 6371.0088;
    const whole = boundingBoxAreaKm2({ south: -90, west: -180, north: 90, east: 180 });
    expect(whole).toBeCloseTo(4 * Math.PI * radius * radius, 0);
    // Published figure for Earth's surface area, ~510.1 million km².
    expect(whole / 1e6).toBeGreaterThan(509);
    expect(whole / 1e6).toBeLessThan(511);
  });

  /**
   * A one-degree square at the equator is about 12,363 km²; the same square at 60° N is
   * about half that, because meridians converge. If the implementation were Δlat × Δlon the
   * two would be equal, and an Arctic query would slip through at twice its intended size.
   */
  it("shrinks with latitude, which a degree rectangle does not", () => {
    const equator = boundingBoxAreaKm2({ south: 0, west: 0, north: 1, east: 1 });
    const sixty = boundingBoxAreaKm2({ south: 60, west: 0, north: 61, east: 1 });
    expect(equator).toBeGreaterThan(12_300);
    expect(equator).toBeLessThan(12_400);
    expect(sixty / equator).toBeGreaterThan(0.45);
    expect(sixty / equator).toBeLessThan(0.55);
  });
});

describe("bounding box validation", () => {
  it("accepts a legitimate small box", () => {
    const result = checkBoundingBox(LONDON);
    expect(result.ok).toBe(true);
  });

  it("refuses a box larger than the submitted-area limit rather than clamping it", () => {
    const huge: BoundingBox = { south: 40, west: -10, north: 55, east: 10 };
    expect(boundingBoxAreaKm2(huge)).toBeGreaterThan(MAX_BBOX_AREA_KM2);
    const result = checkBoundingBox(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("km²");
  });

  it("refuses an antimeridian crossing instead of silently returning nothing", () => {
    const result = checkBoundingBox({ south: -10, west: 179, north: -9, east: -179 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("antimeridian");
  });

  it("refuses an inverted latitude pair", () => {
    const result = checkBoundingBox({ south: 51.6, west: -0.2, north: 51.4, east: 0.1 });
    expect(result.ok).toBe(false);
  });

  it("refuses latitudes outside the Web Mercator range", () => {
    const result = checkBoundingBox({ south: 85.1, west: 0, north: 85.2, east: 1 });
    expect(result.ok).toBe(false);
  });

  it("reads both quoted orders, and they disagree — which is why the caller must say", () => {
    const swne = parseBoundingBox("51.47,-0.16,51.54,0.01", "swne");
    const wsen = parseBoundingBox("-0.16,51.47,0.01,51.54", "wsen");
    expect(swne.ok).toBe(true);
    expect(wsen.ok).toBe(true);
    if (swne.ok && wsen.ok) expect(swne.value).toEqual(wsen.value);

    /*
     * The hazard is not that the wrong order fails — it is that it SUCCEEDS. Read as
     * `wsen`, London's box is a valid small box in the Gulf of Guinea, and nothing about
     * the four numbers says which reading was meant. That is why the order is a parameter
     * and never a guess.
     */
    const misread = parseBoundingBox("51.47,-0.16,51.54,0.01", "wsen");
    expect(misread.ok).toBe(true);
    if (misread.ok && swne.ok) {
      expect(misread.value).not.toEqual(swne.value);
      expect(misread.value.south).toBe(-0.16);
      expect(misread.value.west).toBe(51.47);
    }
  });

  it("refuses text that is not four numbers", () => {
    expect(parseBoundingBox("51.47,-0.16,51.54").ok).toBe(false);
    expect(parseBoundingBox("north,south,east,west").ok).toBe(false);
  });
});

describe("query emission", () => {
  it("puts the bounding box in the global settings, where it binds every statement", () => {
    const query = buildQuery({
      bbox: LONDON,
      statements: [{ selector: "nwr", filters: [{ key: "man_made", value: "water_tower" }] }],
      limit: 50,
    });
    expect(query).toContain(`[bbox:${formatBoundingBox(LONDON)}]`);
    expect(query).toContain(`[timeout:${QUERY_TIMEOUT_SECONDS}]`);
    expect(query).toContain(`[maxsize:${QUERY_MAXSIZE_BYTES}]`);
    expect(query).toContain('nwr["man_made"="water_tower"];');
    expect(query.trimEnd().endsWith("out center 50;")).toBe(true);
  });

  it("emits a negated filter with != and a presence filter with no operator", () => {
    const query = buildQuery({
      bbox: LONDON,
      statements: [
        {
          selector: "nwr",
          filters: [
            { key: "man_made", value: "tower" },
            { key: "tower:type", value: "communication", negated: true },
            { key: "height" },
          ],
        },
      ],
      limit: 10,
    });
    expect(query).toContain('nwr["man_made"="tower"]["tower:type"!="communication"]["height"];');
  });
});

describe("the guarded grammar", () => {
  const valid = buildQuery({
    bbox: LONDON,
    statements: [
      { selector: "nwr", filters: [{ key: "man_made", value: "water_tower" }] },
      { selector: "nwr", filters: [{ key: "railway", value: "level_crossing" }] },
    ],
    limit: DEFAULT_RESULT_LIMIT,
  });

  it("round-trips a generated query unchanged", () => {
    const canonical = canonicaliseQuery(valid);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.value).toBe(valid);
  });

  it("accepts a reader's edit of the tags and re-emits it canonically", () => {
    const edited = valid.replace('"water_tower"', '"chimney"');
    const canonical = canonicaliseQuery(edited);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.value).toContain('nwr["man_made"="chimney"];');
  });

  /**
   * The refusals below are the whole point of the module. Each one is a real construct that
   * would leave the bounding box or cost the shared server far more than a bounded query.
   */
  const refusals: readonly (readonly [string, string])[] = [
    [
      "an explicit per-statement bounding box that overrides the global one",
      valid.replace(
        'nwr["man_made"="water_tower"];',
        'nwr["man_made"="water_tower"](-90,-180,90,180);',
      ),
    ],
    [
      "an around: proximity filter, which reaches outside the box",
      valid.replace('nwr["man_made"="water_tower"];', 'nwr["man_made"="water_tower"](around:50000);'),
    ],
    [
      "an area selector",
      valid.replace('nwr["man_made"="water_tower"];', 'area["name"="France"];'),
    ],
    [
      "a set variable assignment",
      valid.replace('nwr["man_made"="water_tower"];', 'nwr["man_made"="water_tower"]->.a;'),
    ],
    [
      "recursion, which pulls in members outside the box",
      valid.replace('nwr["man_made"="water_tower"];', ">;"),
    ],
    [
      "a regular-expression value match",
      valid.replace('"water_tower"', '~"tower"'),
    ],
    [
      "a bare selector that would return every element in the box",
      valid.replace('nwr["man_made"="water_tower"];', "nwr;"),
    ],
    ["out geom, which returns full geometry", valid.replace("out center", "out geom")],
    ["out meta, which returns every version and changeset", valid.replace("out center", "out meta")],
    [
      "a second out statement",
      `${valid}out count;`,
    ],
    [
      "a raised timeout",
      valid.replace(`[timeout:${QUERY_TIMEOUT_SECONDS}]`, "[timeout:180]"),
    ],
    [
      "a raised maxsize",
      valid.replace(`[maxsize:${QUERY_MAXSIZE_BYTES}]`, "[maxsize:1073741824]"),
    ],
    ["an out:xml settings block", valid.replace("[out:json]", "[out:xml]")],
    [
      "a bounding box larger than the area limit",
      valid.replace(`[bbox:${formatBoundingBox(LONDON)}]`, "[bbox:40,-10,55,10]"),
    ],
    [
      "an out limit above the ceiling",
      valid.replace(`out center ${DEFAULT_RESULT_LIMIT};`, `out center ${MAX_RESULT_LIMIT + 1};`),
    ],
    ["a semicolon injected into a tag value", valid.replace('"water_tower"', '"a";nwr["x"="y"]')],
    ["a bracket injected into a tag key", valid.replace('"man_made"', '"man]["x')],
  ];

  for (const [description, query] of refusals) {
    it(`refuses ${description}`, () => {
      const result = parseGuardedQuery(query);
      expect(result.ok, query).toBe(false);
    });
  }

  it("refuses a query longer than the length cap before parsing it", () => {
    const result = parseGuardedQuery("x".repeat(5000));
    expect(result.ok).toBe(false);
  });

  it("refuses more statements than the cap", () => {
    const many = buildQuery({
      bbox: LONDON,
      statements: Array.from({ length: 9 }, () => ({
        selector: "nwr" as const,
        filters: [{ key: "amenity", value: "fuel" }],
      })),
      limit: 10,
    });
    expect(parseGuardedQuery(many).ok).toBe(false);
  });

  /**
   * The security property stated as a test: whatever comes out of `canonicaliseQuery` was
   * emitted by `buildQuery` from a parsed structure, so it can never contain a byte the
   * grammar did not accept.
   */
  it("never emits a character the grammar refuses, even from a hostile edit", () => {
    const hostile = valid.replace('"water_tower"', '"water_tower"](around:9999999)["x"="y');
    const result = canonicaliseQuery(hostile);
    expect(result.ok).toBe(false);
  });
});

describe("presets", () => {
  it("has a unique id per preset and every preset in a declared group", () => {
    const ids = FEATURE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = PRESET_GROUPS.map((group) => group.id);
    for (const preset of FEATURE_PRESETS) {
      expect(groups, preset.id).toContain(preset.group);
      expect(preset.note.length, preset.id).toBeGreaterThan(40);
    }
  });

  /**
   * Every preset must survive the grammar. A preset that the parser refuses would be a tool
   * that generates a query it will not then submit, which is the worst possible bug shape:
   * it looks like the upstream refused you.
   */
  it("generates a query that its own parser accepts, for every preset", () => {
    for (const preset of FEATURE_PRESETS) {
      const query = queryFromPresets([preset.id], LONDON);
      expect(query.ok, preset.id).toBe(true);
      if (query.ok) expect(parseGuardedQuery(query.value).ok, preset.id).toBe(true);
    }
  });

  it("refuses an unknown preset id rather than emitting an empty union", () => {
    expect(queryFromPresets(["not-a-feature"], LONDON).ok).toBe(false);
    expect(queryFromPresets([], LONDON).ok).toBe(false);
  });

  it("uses nwr everywhere, because a stadium may be a node, a way or a relation", () => {
    for (const preset of FEATURE_PRESETS) {
      expect(preset.statement.selector, preset.id).toBe("nwr");
    }
  });
});

describe("response normalisation", () => {
  /** The shape Overpass returns for `out center`: nodes carry lat/lon, ways carry center. */
  const payload = {
    version: 0.6,
    generator: "Overpass API 0.7.62.7 5e1a5f6d",
    osm3s: {
      timestamp_osm_base: "2026-08-31T22:14:23Z",
      copyright:
        "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
    },
    elements: [
      {
        type: "node",
        id: 1234567890,
        lat: 51.5007,
        lon: -0.1246,
        tags: { man_made: "water_tower", name: "Test Tower" },
      },
      {
        type: "way",
        id: 987654321,
        center: { lat: 51.51, lon: -0.13 },
        tags: { man_made: "water_tower" },
      },
      { type: "relation", id: 42, tags: { man_made: "water_tower" } },
    ],
  };

  it("reads a node's lat/lon and a way's center into one shape", () => {
    const result = normaliseOverpass(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.features).toHaveLength(2);
    expect(result.value.features[0]?.id).toBe("node/1234567890");
    expect(result.value.features[0]?.label).toBe("Test Tower");
    expect(result.value.features[1]?.latitude).toBe(51.51);
    expect(result.value.features[1]?.osmUrl).toBe("https://www.openstreetmap.org/way/987654321");
  });

  it("counts elements it could not place, so the count is not quietly smaller", () => {
    const result = normaliseOverpass(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.elementCount).toBe(3);
    expect(result.value.features).toHaveLength(2);
  });

  it("labels an unnamed element by type and id rather than leaving it blank", () => {
    const result = normaliseOverpass(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.features[1]?.label).toBe("Unnamed way 987654321");
  });

  it("reads the data timestamp, which is the OSM extract's clock and not ours", () => {
    const result = normaliseOverpass(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dataTimestamp).toBe("2026-08-31T22:14:23Z");
  });

  /**
   * The one that matters. Overpass answers a timed-out query with HTTP 200, a `remark`, and
   * a PARTIAL elements array. A client that drops the remark shows an incomplete answer as a
   * complete one, which on a geolocation tool means concluding a feature is not there.
   */
  it("carries the upstream's remark through, because a 200 with a remark is a partial answer", () => {
    const result = normaliseOverpass({
      ...payload,
      remark: "runtime error: Query timed out in \"query\" at line 3 after 25 seconds.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.remark).toContain("timed out");
    expect(result.value.features.length).toBeGreaterThan(0);
  });

  it("fails rather than reporting zero features when the payload is a different shape", () => {
    expect(normaliseOverpass({ error: "nope" }).ok).toBe(false);
    expect(normaliseOverpass("<html>503</html>").ok).toBe(false);
    expect(normaliseOverpass(null).ok).toBe(false);
  });

  it("reports zero features honestly when the server really returned none", () => {
    const result = normaliseOverpass({ ...payload, elements: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.features).toHaveLength(0);
    expect(result.value.elementCount).toBe(0);
  });
});
