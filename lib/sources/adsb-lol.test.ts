import { describe, expect, it } from "vitest";

import {
  adsbLol,
  createAdsbLolAdapter,
  DEFAULT_VIEWPORT,
  normaliseAdsbLol,
  quantiseViewport,
  viewportFromEnv,
} from "./adsb-lol";

/** Real payload: 250 nm around London, captured from api.adsb.lol on 2026-08-31, unedited. */
import fixture from "./__fixtures__/adsb-lol.json";

describe("adsb-lol normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const result = normaliseAdsbLol(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      expect(feature.kind).toBe("aircraft");
      expect(feature.properties.icao24).toMatch(/^[0-9a-f~]+$/i);
      expect(feature.label).not.toBe("");
      expect(Math.abs(feature.longitude)).toBeLessThanOrEqual(180);
      expect(Math.abs(feature.latitude)).toBeLessThanOrEqual(90);
    }
  });

  it("takes observedAt from the upstream's `now`, not our clock", () => {
    const result = normaliseAdsbLol(fixture, new Date("2000-01-01T00:00:00Z"));
    if (!result.ok) throw new Error("fixture should parse");
    expect(result.observedAt.getTime()).toBe(fixture.now);
  });

  it("converts altitude to metres, because the contract says metres", () => {
    const result = normaliseAdsbLol(fixture);
    if (!result.ok) throw new Error("fixture should parse");
    const airborne = result.features.find((f) => f.properties.altitudeFt !== null);
    expect(airborne).toBeDefined();
    if (!airborne || airborne.properties.altitudeFt === null) return;
    expect(airborne.altitude).toBeCloseTo(airborne.properties.altitudeFt * 0.3048, 3);
  });

  it('reads the literal "ground" altitude as on-ground rather than as a number', () => {
    const result = normaliseAdsbLol({
      now: Date.now(),
      ac: [{ hex: "abc123", lat: 51.5, lon: -0.1, alt_baro: "ground" }],
    });
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features[0]?.properties.onGround).toBe(true);
    expect(result.features[0]?.properties.altitudeFt).toBeNull();
    expect(result.features[0]?.altitude).toBeUndefined();
  });

  it('treats emergency "none" as an absence, not as a state to render', () => {
    const result = normaliseAdsbLol({
      now: Date.now(),
      ac: [
        { hex: "aaa111", lat: 1, lon: 1, emergency: "none" },
        { hex: "bbb222", lat: 2, lon: 2, emergency: "general" },
      ],
    });
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features[0]?.properties.emergency).toBeNull();
    expect(result.features[1]?.properties.emergency).toBe("general");
  });

  it("drops aircraft with no position rather than drawing them at null island", () => {
    const result = normaliseAdsbLol({
      now: Date.now(),
      ac: [{ hex: "nopos" }, { hex: "haspos", lat: 10, lon: 10 }],
    });
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features.map((f) => f.id)).toEqual(["haspos"]);
  });

  it("returns schemaChanged rather than rendering an empty, confident, wrong sky", () => {
    const result = normaliseAdsbLol({ error: "service unavailable" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("tolerates an upstream that adds fields", () => {
    const extended = { ...fixture, brandNew: 1, ac: fixture.ac.map((a) => ({ ...a, brandNew: 1 })) };
    expect(normaliseAdsbLol(extended).ok).toBe(true);
  });
});

describe("adsb-lol viewport handling", () => {
  it("quantises and clamps anything that could reach a URL", () => {
    const q = quantiseViewport({ latitude: 91.23456, longitude: -200.9, radiusNm: 9999 });
    expect(q.latitude).toBe(90);
    expect(q.longitude).toBe(-180);
    // The upstream's own documented maximum radius.
    expect(q.radiusNm).toBe(250);
  });

  it("rounds coordinates to one decimal place, bounding the number of distinct requests", () => {
    expect(quantiseViewport({ latitude: 51.50719, longitude: -0.12775, radiusNm: 50 })).toEqual({
      latitude: 51.5,
      longitude: -0.1,
      radiusNm: 50,
    });
  });

  it("falls back to the default viewport on a malformed configuration rather than failing boot", () => {
    expect(viewportFromEnv("not,a,viewport")).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFromEnv("51.5,-0.1")).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFromEnv("")).toEqual(DEFAULT_VIEWPORT);
  });

  it("reads a well-formed configuration", () => {
    expect(viewportFromEnv("35.68,139.77,100")).toEqual({
      latitude: 35.7,
      longitude: 139.8,
      radiusNm: 100,
    });
  });

  it("gives each non-default viewport its own slug, so caches and cooldowns cannot collide", () => {
    const tokyo = createAdsbLolAdapter({ latitude: 35.68, longitude: 139.77, radiusNm: 100 });
    expect(tokyo.slug).not.toBe(adsbLol.slug);
    expect(createAdsbLolAdapter(DEFAULT_VIEWPORT).slug).toBe(adsbLol.slug);
  });
});

describe("adsb-lol adapter contract", () => {
  it("carries the ODbL attribution its licence makes a condition of use", () => {
    expect(adsbLol.attribution.licence).toBe("ODbL 1.0");
    expect(adsbLol.attribution.text).toContain("adsb.lol");
  });

  it("polls no faster than the measured refusal floor allows", () => {
    // v1 measured refusals at 10 requests/minute. 30s per viewport is 2/minute; three
    // viewports is 6/minute, the ceiling settled on after QA finding Q-02. A change that
    // lowers this number without new measurement is the mistake Q-02 already cost us once.
    expect(adsbLol.ttlSeconds).toBeGreaterThanOrEqual(30);
  });

  it("needs no API key today", () => {
    expect(adsbLol.apiKeyEnvVar).toBeUndefined();
  });
});
