import { describe, expect, it } from "vitest";

import { normaliseUsgs, usgsEarthquakes } from "./usgs-earthquakes";

/**
 * The fixture is a REAL payload, captured from the live feed on 2026-08-31 and committed
 * unedited. An invented fixture tests that our own imagination is self-consistent; a captured
 * one is the only thing that catches the failure these tests exist for — the upstream
 * quietly changing shape.
 */
import fixture from "./__fixtures__/usgs-earthquakes.json";

describe("usgs-earthquakes normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const result = normaliseUsgs(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      expect(feature.kind).toBe("earthquakes");
      expect(feature.id).toBeTruthy();
      expect(feature.longitude).toBeGreaterThanOrEqual(-180);
      expect(feature.longitude).toBeLessThanOrEqual(180);
      expect(feature.latitude).toBeGreaterThanOrEqual(-90);
      expect(feature.latitude).toBeLessThanOrEqual(90);
      expect(feature.label).not.toBe("");
    }
  });

  it("takes observedAt from the upstream's own clock, not ours", () => {
    const result = normaliseUsgs(fixture, new Date("2000-01-01T00:00:00Z"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observedAt.getTime()).toBe(fixture.metadata.generated);
  });

  it("reads depth as a negative altitude in metres", () => {
    const result = normaliseUsgs(fixture);
    if (!result.ok) throw new Error("fixture should parse");
    const withDepth = result.features.find((f) => f.properties.depthKm !== null);
    expect(withDepth).toBeDefined();
    if (!withDepth) return;
    // A quake is BELOW the surface. A positive altitude would draw it in the stratosphere.
    expect(withDepth.altitude).toBeCloseTo(-(withDepth.properties.depthKm as number) * 1000, 3);
  });

  it("keeps a link back to the origin on every feature the upstream gave one for", () => {
    const result = normaliseUsgs(fixture);
    if (!result.ok) throw new Error("fixture should parse");
    expect(result.features.every((f) => f.sourceUrl?.startsWith("https://"))).toBe(true);
  });

  it("drops events with no usable position rather than drawing them at null island", () => {
    const broken = {
      metadata: { generated: Date.now() },
      features: [
        { id: "no-geometry", properties: { mag: 3 }, geometry: null },
        { id: "short-coords", properties: { mag: 3 }, geometry: { coordinates: [12] } },
        { id: "null-lat", properties: { mag: 3 }, geometry: { coordinates: [12, null, 5] } },
        { id: "good", properties: { mag: 3, title: "M 3.0 - somewhere" }, geometry: { coordinates: [12, 34, 5] } },
      ],
    };
    const result = normaliseUsgs(broken);
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features.map((f) => f.id)).toEqual(["good"]);
  });

  it("returns schemaChanged — not a throw — when the shape moves", () => {
    const result = normaliseUsgs({ metadata: { generated: "not-a-number" }, features: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("does not silently render an unrelated payload as zero earthquakes", () => {
    // The failure that matters: a completely different document must degrade the layer, not
    // parse as an empty, confident, wrong map.
    const result = normaliseUsgs({ error: "service unavailable" });
    expect(result.ok).toBe(false);
  });

  it("tolerates an upstream that adds fields", () => {
    const extended = {
      ...fixture,
      metadata: { ...fixture.metadata, newField: true },
      features: fixture.features.map((f) => ({ ...f, brandNew: "field" })),
    };
    expect(normaliseUsgs(extended).ok).toBe(true);
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

  it("exposes the schema it validates against, so an operator can see what we expect", () => {
    expect(usgsEarthquakes.responseSchema.safeParse(fixture).success).toBe(true);
  });
});
