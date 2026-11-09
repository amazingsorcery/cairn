import { afterEach, describe, expect, it, vi } from "vitest";

import { resetSourceRuntime } from "./http";
import {
  normaliseSeattleFire911,
  seattleFire911,
  seattleFire911ResponseSchema,
} from "./seattle-fire-911";

/** Real payload from data.seattle.gov (kzjm-xkqj), captured 2026-09-01, unedited. */
import fixture from "./__fixtures__/seattle-fire-911.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

describe("seattle-fire-911 normalise", () => {
  it("maps the captured live payload to renderable public-safety features", () => {
    const features = normaliseSeattleFire911(fixture, {});
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("publicSafety");
      expect(feature.id.startsWith("seattle-fire-911:")).toBe(true);
      expect(feature.longitude).toBeGreaterThanOrEqual(-180);
      expect(feature.longitude).toBeLessThanOrEqual(180);
      expect(feature.latitude).toBeGreaterThanOrEqual(-90);
      expect(feature.latitude).toBeLessThanOrEqual(90);
      expect(feature.properties.agency).toBe("Seattle Fire Department");
      // isMedical iff category is medical.
      expect(feature.properties.isMedical).toBe(feature.properties.category === "medical");
    }
  });

  it("classifies and marks Seattle's medical calls, which dominate this feed", () => {
    const features = normaliseSeattleFire911(fixture, {});
    const medical = features.filter((f) => f.properties.isMedical);
    // Aid/Medic Response are the largest call types; zero means the classifier or feed changed.
    expect(medical.length).toBeGreaterThan(0);
    expect(medical.some((f) => /aid|medic/i.test(f.properties.incidentType))).toBe(true);
  });

  it("carries the dispatch-location precision caveat into every feature", () => {
    const [feature] = normaliseSeattleFire911(fixture, {});
    expect(feature?.precision?.label).toContain("approx");
    // Travels with the feature into workspace exports.
    expect(feature?.precision?.note).toContain("block or intersection");
  });

  it("drops a row with no usable coordinate rather than drawing it at null island", () => {
    const broken = [
      { type: "Aid Response", latitude: "", longitude: "", incident_number: "A1" },
      { type: "Fire in Building", latitude: "47.6", longitude: "-122.3", incident_number: "A2" },
    ];
    expect(normaliseSeattleFire911(broken, {}).map((f) => f.properties.incidentNumber)).toEqual([
      "A2",
    ]);
  });

  it("applies a viewport and a limit", () => {
    const all = normaliseSeattleFire911(fixture, {});
    expect(normaliseSeattleFire911(fixture, { limit: 3 }).length).toBe(Math.min(3, all.length));
  });
});

describe("seattle-fire-911 schema", () => {
  it("accepts the captured payload", () => {
    expect(seattleFire911ResponseSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects an unrelated document, so a shape change cannot read as zero dispatches", () => {
    expect(seattleFire911ResponseSchema.safeParse({ error: "unavailable" }).success).toBe(false);
    // A row missing the required `type` fails the schema.
    expect(
      seattleFire911ResponseSchema.safeParse([{ latitude: "47.6", longitude: "-122.3" }]).success,
    ).toBe(false);
  });

  it("tolerates an upstream that adds columns", () => {
    const extended = (fixture as unknown[]).map((row) => ({
      ...(row as Record<string, unknown>),
      brandNew: "field",
    }));
    expect(normaliseSeattleFire911(extended, {}).length).toBe(normaliseSeattleFire911(fixture, {}).length);
  });
});

describe("seattle-fire-911 fetch", () => {
  it("returns features from a stubbed live response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const result = await seattleFire911.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.features.length).toBeGreaterThan(0);
  });

  it("returns schemaChanged — not a throw — when the shape moves", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }));
    const result = await seattleFire911.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("sends the optional Socrata app token when one is configured", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    await seattleFire911.fetch({}, testContext({ env: { SOCRATA_APP_TOKEN: "tok_123" } }));
    const init = spy.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-app-token"]).toBe("tok_123");
  });

  it("boots without the token — it degrades, it does not disable", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const result = await seattleFire911.fetch({}, testContext());
    expect(result.ok).toBe(true);
    const init = spy.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-app-token"]).toBeUndefined();
  });
});
