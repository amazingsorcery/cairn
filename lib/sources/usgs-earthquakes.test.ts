import { afterEach, describe, expect, it, vi } from "vitest";

import { resetSourceRuntime } from "./http";
import { normaliseUsgs, usgsEarthquakes, usgsResponseSchema } from "./usgs-earthquakes";

/**
 * The fixture is a REAL payload, captured from the live feed on 2026-08-31 and committed
 * unedited. An invented fixture tests that our own imagination is self-consistent; a captured
 * one is the only thing that catches the failure these tests exist for — the upstream
 * quietly changing shape.
 */
import fixture from "./__fixtures__/usgs-earthquakes.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

describe("usgs-earthquakes normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const features = normaliseUsgs(fixture, {});

    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("earthquakes");
      expect(feature.id).toBeTruthy();
      expect(feature.longitude).toBeGreaterThanOrEqual(-180);
      expect(feature.longitude).toBeLessThanOrEqual(180);
      expect(feature.latitude).toBeGreaterThanOrEqual(-90);
      expect(feature.latitude).toBeLessThanOrEqual(90);
      expect(feature.label).not.toBe("");
    }
  });

  it("reads depth as a negative altitude in metres", () => {
    const withDepth = normaliseUsgs(fixture, {}).find((f) => f.properties.depthKm !== null);
    expect(withDepth).toBeDefined();
    if (!withDepth) return;
    // A quake is BELOW the surface. A positive altitude would draw it in the stratosphere.
    expect(withDepth.altitude).toBeCloseTo(-(withDepth.properties.depthKm as number) * 1000, 3);
  });

  it("keeps a link back to the origin on every feature the upstream gave one for", () => {
    expect(normaliseUsgs(fixture, {}).every((f) => f.sourceUrl?.startsWith("https://"))).toBe(true);
  });

  it("drops events with no usable position rather than drawing them at null island", () => {
    const broken = {
      metadata: { generated: Date.now() },
      features: [
        { id: "no-geometry", properties: { mag: 3 }, geometry: null },
        { id: "short-coords", properties: { mag: 3 }, geometry: { coordinates: [12] } },
        { id: "null-lat", properties: { mag: 3 }, geometry: { coordinates: [12, null, 5] } },
        {
          id: "good",
          properties: { mag: 3, title: "M 3.0 - somewhere" },
          geometry: { coordinates: [12, 34, 5] },
        },
      ],
    };
    expect(normaliseUsgs(broken, {}).map((f) => f.id)).toEqual(["good"]);
  });

  it("applies a viewport, because the summary feeds are global and cannot filter upstream", () => {
    const all = normaliseUsgs(fixture, {});
    // A one-degree box somewhere in the Pacific: strictly fewer features, and every one inside.
    const boxed = normaliseUsgs(fixture, {
      bbox: { west: 140, south: 30, east: 160, north: 50 },
    });
    expect(boxed.length).toBeLessThan(all.length);
    for (const feature of boxed) {
      expect(feature.longitude).toBeGreaterThanOrEqual(140);
      expect(feature.longitude).toBeLessThanOrEqual(160);
      expect(feature.latitude).toBeGreaterThanOrEqual(30);
      expect(feature.latitude).toBeLessThanOrEqual(50);
    }
  });

  it("applies a limit", () => {
    expect(normaliseUsgs(fixture, { limit: 3 })).toHaveLength(3);
  });

  it("tolerates an upstream that adds fields", () => {
    const extended = {
      ...fixture,
      metadata: { ...fixture.metadata, newField: true },
      features: fixture.features.map((f) => ({ ...f, brandNew: "field" })),
    };
    expect(normaliseUsgs(extended, {}).length).toBe(normaliseUsgs(fixture, {}).length);
  });
});

describe("usgs-earthquakes schema", () => {
  it("accepts the captured payload", () => {
    expect(usgsResponseSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an unrelated document, so a shape change cannot read as zero earthquakes", () => {
    // The decision that matters, and it is made by the SCHEMA in `fetch` — never by
    // `normalise`, which has no way to signal failure.
    expect(usgsResponseSchema.safeParse({ error: "service unavailable" }).success).toBe(false);
    expect(usgsResponseSchema.safeParse({ metadata: { generated: "nope" }, features: [] }).success).toBe(
      false,
    );
  });
});

describe("usgs-earthquakes fetch", () => {
  it("takes observedAt from the upstream's own clock, not ours", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));

    const result = await usgsEarthquakes.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observedAt.getTime()).toBe(fixture.metadata.generated);
  });

  it("returns schemaChanged — not a throw — when the shape moves", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }));

    const result = await usgsEarthquakes.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("selects a feed only from the documented allowlist", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));

    await usgsEarthquakes.fetch({}, testContext({ env: { USGS_QUAKE_FEED: "../../etc/passwd" } }));
    // An operator-supplied string reaching a server-side fetch URL is the SSRF shape ADR 0019
    // calls v2's top risk. An unrecognised value falls back rather than being interpolated.
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    );

    await usgsEarthquakes.fetch({}, testContext({ env: { USGS_QUAKE_FEED: "significant_week" } }));
    expect(String(spy.mock.calls[1]?.[0])).toContain("significant_week.geojson");
  });
});

describe("usgs-earthquakes adapter contract", () => {
  it("carries the attribution its licence expects, as data", () => {
    expect(usgsEarthquakes.attribution.text).toContain("U.S. Geological Survey");
    expect(usgsEarthquakes.attribution.licence).toBe("public domain (US Government)");
  });

  it("respects the feed's own one-minute cache directive", () => {
    expect(usgsEarthquakes.ttlSeconds).toBe(60);
  });

  it("needs no API key", () => {
    expect(usgsEarthquakes.apiKeyEnvVar).toBeUndefined();
  });
});
