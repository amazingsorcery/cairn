import { afterEach, describe, expect, it, vi } from "vitest";

import {
  adsbLol,
  adsbLolResponseSchema,
  DEFAULT_VIEWPORT,
  normaliseAdsbLol,
  quantiseViewport,
  resolveViewport,
  viewportFromBbox,
  viewportFromEnv,
} from "./adsb-lol";
import { resetSourceRuntime } from "./http";

/** Real payload: 250 nm around London, captured from api.adsb.lol on 2026-08-31, unedited. */
import fixture from "./__fixtures__/adsb-lol.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

describe("adsb-lol normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const features = normaliseAdsbLol(fixture, {});

    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("aircraft");
      expect(feature.properties.icao24).toMatch(/^[0-9a-f~]+$/i);
      expect(feature.label).not.toBe("");
      expect(Math.abs(feature.longitude)).toBeLessThanOrEqual(180);
      expect(Math.abs(feature.latitude)).toBeLessThanOrEqual(90);
    }
  });

  it("converts altitude to metres, because the contract says metres", () => {
    const airborne = normaliseAdsbLol(fixture, {}).find((f) => f.properties.altitudeFt !== null);
    expect(airborne).toBeDefined();
    if (!airborne || airborne.properties.altitudeFt === null) return;
    expect(airborne.altitude).toBeCloseTo(airborne.properties.altitudeFt * 0.3048, 3);
  });

  it('reads the literal "ground" altitude as on-ground rather than as a number', () => {
    const features = normaliseAdsbLol(
      { now: Date.now(), ac: [{ hex: "abc123", lat: 51.5, lon: -0.1, alt_baro: "ground" }] },
      {},
    );
    expect(features[0]?.properties.onGround).toBe(true);
    expect(features[0]?.properties.altitudeFt).toBeNull();
    expect(features[0]?.altitude).toBeUndefined();
  });

  /**
   * Asserted against the captured payload: a hand-written fixture would likely miss that
   * `alt_baro` is a string for many real aircraft.
   */
  it("handles the string alt_baro that a real response is full of", () => {
    const raw = fixture.ac.filter((a) => a.alt_baro === "ground");
    // 41 of 165 in the capture.
    expect(raw.length).toBeGreaterThan(0);

    const onGround = normaliseAdsbLol(fixture, {}).filter((f) => f.properties.onGround);
    expect(onGround.length).toBe(raw.length);

    for (const feature of onGround) {
      // On the ground means no altitude at all.
      expect(feature.properties.altitudeFt).toBeNull();
      expect(feature.altitude).toBeUndefined();
      expect(feature.label.trim()).not.toBe("");
    }
  });

  it("still labels the aircraft in a real response that broadcast no callsign", () => {
    const raw = fixture.ac.filter((a) => !a.flight || a.flight.trim() === "");
    expect(raw.length).toBeGreaterThan(0);

    const anonymous = normaliseAdsbLol(fixture, {}).filter((f) => f.properties.callsign === null);
    expect(anonymous.length).toBe(raw.length);

    for (const feature of anonymous) {
      // Falls back to registration, then hex.
      expect(feature.label.trim()).not.toBe("");
      expect(feature.label).toBe(
        feature.properties.registration ?? feature.properties.icao24.toUpperCase(),
      );
    }
  });

  it("gives every feature in the captured payload a non-empty label", () => {
    const features = normaliseAdsbLol(fixture, {});
    expect(features.length).toBe(fixture.ac.length);
    expect(features.every((f) => f.label.trim().length > 0)).toBe(true);
  });

  it('treats emergency "none" as an absence, not as a state to render', () => {
    const features = normaliseAdsbLol(
      {
        now: Date.now(),
        ac: [
          { hex: "aaa111", lat: 1, lon: 1, emergency: "none" },
          { hex: "bbb222", lat: 2, lon: 2, emergency: "general" },
        ],
      },
      {},
    );
    expect(features[0]?.properties.emergency).toBeNull();
    expect(features[1]?.properties.emergency).toBe("general");
  });

  it("drops aircraft with no position rather than drawing them at null island", () => {
    const features = normaliseAdsbLol(
      { now: Date.now(), ac: [{ hex: "nopos" }, { hex: "haspos", lat: 10, lon: 10 }] },
      {},
    );
    expect(features.map((f) => f.id)).toEqual(["haspos"]);
  });

  it("does not re-clip to the bbox, because the upstream already filtered to the circle", () => {
    const all = normaliseAdsbLol(fixture, {});
    const boxed = normaliseAdsbLol(fixture, {
      bbox: { west: -0.2, south: 51.4, east: -0.1, north: 51.6 },
    });
    expect(boxed.length).toBe(all.length);
  });

  it("applies a limit", () => {
    expect(normaliseAdsbLol(fixture, { limit: 5 })).toHaveLength(5);
  });

  it("tolerates an upstream that adds fields", () => {
    const extended = { ...fixture, brandNew: 1, ac: fixture.ac.map((a) => ({ ...a, brandNew: 1 })) };
    expect(normaliseAdsbLol(extended, {}).length).toBe(normaliseAdsbLol(fixture, {}).length);
  });
});

describe("adsb-lol schema", () => {
  it("accepts the captured payload", () => {
    expect(adsbLolResponseSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an unrelated document, so a shape change cannot read as an empty sky", () => {
    expect(adsbLolResponseSchema.safeParse({ error: "service unavailable" }).success).toBe(false);
    // `ac` and `now` are required.
    expect(adsbLolResponseSchema.safeParse({ ac: [] }).success).toBe(false);
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

  it("turns a bbox into a circle that CONTAINS it, not one inscribed within it", () => {
    // An inscribed circle would miss aircraft near the corners.
    const view = viewportFromBbox({ west: -1, south: 51, east: 1, north: 52 });
    expect(view.latitude).toBeCloseTo(51.5, 1);
    expect(view.longitude).toBeCloseTo(0, 1);

    // Half-diagonal of a 1° tall, 2° wide box at 51.5°N: ~1° lat is 111 km, and 2° lon at
    // this latitude is ~138 km, so the corner is ~sqrt(55.5² + 69²) ≈ 88 km ≈ 48 nm.
    expect(view.radiusNm).toBeGreaterThan(44);
    expect(view.radiusNm).toBeLessThan(55);
  });

  it("never asks for more than the documented 250 nm, however large the bbox", () => {
    expect(viewportFromBbox({ west: -180, south: -90, east: 180, north: 90 }).radiusNm).toBe(250);
  });

  it("falls back to the configured viewport when a query carries no bbox", () => {
    expect(resolveViewport({}, () => undefined)).toEqual(DEFAULT_VIEWPORT);
    expect(resolveViewport({}, (n) => (n === "AIRCRAFT_VIEWPORT" ? "35.68,139.77,100" : undefined))).toEqual(
      { latitude: 35.7, longitude: 139.8, radiusNm: 100 },
    );
  });

  it("falls back on a malformed configuration rather than failing the worker's boot", () => {
    expect(viewportFromEnv("not,a,viewport")).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFromEnv("51.5,-0.1")).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFromEnv("")).toEqual(DEFAULT_VIEWPORT);
    expect(viewportFromEnv(undefined)).toEqual(DEFAULT_VIEWPORT);
  });
});

describe("adsb-lol fetch", () => {
  it("takes observedAt from the upstream's `now`, not our clock", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));

    const result = await adsbLol.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observedAt.getTime()).toBe(fixture.now);
  });

  it("builds its URL from the query's bbox, with no pre-bound instance in the registry", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));

    await adsbLol.fetch({ bbox: { west: 139.6, south: 35.5, east: 139.9, north: 35.8 } }, testContext());
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("/v2/lat/35.7/lon/139.8/dist/");
  });

  it("returns schemaChanged rather than an empty, confident, wrong sky", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }));

    const result = await adsbLol.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("stops calling after the upstream refuses, and reports the wait", async () => {
    // Their limiter wins over our TTL.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("slow down", { status: 429 }));

    const first = await adsbLol.fetch({}, testContext());
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.failure.kind).toBe("rateLimited");

    const callsSoFar = spy.mock.calls.length;
    await adsbLol.fetch({}, testContext());
    expect(spy.mock.calls.length).toBe(callsSoFar);
  });
});

describe("adsb-lol adapter contract", () => {
  it("carries the ODbL attribution its licence makes a condition of use", () => {
    expect(adsbLol.attribution.licence).toBe("ODbL 1.0");
    expect(adsbLol.attribution.text).toContain("adsb.lol");
  });

  it("polls no faster than the measured refusal floor allows", () => {
    // Refusals were measured at 10 req/min. 30s per viewport is 2/min; three viewports stay
    // within the 6/min ceiling. Don't lower without new measurements.
    expect(adsbLol.ttlSeconds).toBeGreaterThanOrEqual(30);
  });

  it("needs no API key today", () => {
    expect(adsbLol.apiKeyEnvVar).toBeUndefined();
  });
});
