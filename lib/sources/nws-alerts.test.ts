import { beforeEach, describe, expect, it } from "vitest";

import { representativePoint } from "./geometry";
import {
  clearZoneCache,
  normaliseNwsAlerts,
  nwsAlerts,
  nwsZoneResponseSchema,
  primeZoneCache,
  unresolvedZones,
} from "./nws-alerts";

/** Both fixtures are real payloads captured from api.weather.gov on 2026-08-31, unedited. */
import alertsFixture from "./__fixtures__/nws-alerts.json";
import zoneFixture from "./__fixtures__/nws-zone.json";

/**
 * The captured zone is `AZZ004`, Kaibab Plateau, Arizona — chosen because it is the first
 * zone the alerts fixture needs and cannot place on its own. (Pima County, the other obvious
 * candidate, turned out to belong to an alert that already carries a polygon, so priming it
 * proved nothing. Worth recording: the first version of this test passed for the wrong reason.)
 */
function primeFromZoneFixture(): void {
  const parsed = nwsZoneResponseSchema.parse(zoneFixture);
  const point = representativePoint(parsed.geometry);
  if (!point) throw new Error("captured zone fixture should have geometry");
  primeZoneCache(parsed.properties.id, { ...point, name: parsed.properties.name ?? null });
}

beforeEach(() => {
  clearZoneCache();
});

describe("nws-alerts normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const result = normaliseNwsAlerts(alertsFixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      expect(feature.kind).toBe("weather");
      expect(Number.isFinite(feature.longitude)).toBe(true);
      expect(Number.isFinite(feature.latitude)).toBe(true);
      expect(feature.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("takes observedAt from the collection's own `updated`, not our clock", () => {
    const result = normaliseNwsAlerts(alertsFixture, new Date("2000-01-01T00:00:00Z"));
    if (!result.ok) throw new Error("fixture should parse");
    expect(result.observedAt.toISOString()).toBe(new Date(alertsFixture.updated).toISOString());
  });

  it("places a zone-only alert once its zone is resolved, and says the point is a zone centroid", () => {
    // The reason this adapter is more than a GeoJSON pass-through: on 2026-08-31 only 2 of
    // the 15 alerts in this fixture carried a polygon.
    const before = normaliseNwsAlerts(alertsFixture);
    if (!before.ok) throw new Error("fixture should parse");

    primeFromZoneFixture();
    const after = normaliseNwsAlerts(alertsFixture);
    if (!after.ok) throw new Error("fixture should parse");

    expect(after.features.length).toBeGreaterThan(before.features.length);

    const placed = after.features.find((f) => f.properties.locationBasis === "zone");
    expect(placed).toBeDefined();
    expect(placed?.properties.zoneCode).toBe("AZZ004");
    // Kaibab Plateau, northern Arizona. If the centroid ever lands outside the American
    // southwest, something has gone wrong in the ring averaging.
    expect(placed?.latitude).toBeGreaterThan(35);
    expect(placed?.latitude).toBeLessThan(38);
    expect(placed?.longitude).toBeGreaterThan(-114);
    expect(placed?.longitude).toBeLessThan(-110);
  });

  it("labels polygon-derived points as polygon, not zone", () => {
    const result = normaliseNwsAlerts(alertsFixture);
    if (!result.ok) throw new Error("fixture should parse");
    const fromPolygon = result.features.filter((f) => f.properties.locationBasis === "polygon");
    expect(fromPolygon.length).toBeGreaterThan(0);
    expect(fromPolygon.every((f) => f.properties.zoneCode === null)).toBe(true);
  });

  it("returns schemaChanged rather than throwing when the shape moves", () => {
    const result = normaliseNwsAlerts({ type: "FeatureCollection", features: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("does not render an unrelated document as 'no weather warnings anywhere'", () => {
    expect(normaliseNwsAlerts({ status: 503, detail: "unavailable" }).ok).toBe(false);
  });
});

describe("nws-alerts zone warm-up", () => {
  it("is bounded per poll, so a cold start is not a 700-request burst", () => {
    // The lesson from QA finding Q-02: our own limiter must never allow a burst just
    // because the upstream has not published a number.
    expect(unresolvedZones(alertsFixture, 3).length).toBeLessThanOrEqual(3);
  });

  it("never re-requests a zone already in the cache, including a cached miss", () => {
    const first = unresolvedZones(alertsFixture, 50);
    expect(first.length).toBeGreaterThan(0);
    for (const ugc of first) primeZoneCache(ugc, null);
    expect(unresolvedZones(alertsFixture, 50)).toEqual([]);
  });

  it("only ever asks for well-formed UGC codes", () => {
    for (const ugc of unresolvedZones(alertsFixture, 50)) {
      expect(ugc).toMatch(/^[A-Z]{2}[CZ]\d{3}$/);
    }
  });

  it("asks for one zone per alert, not every zone a multi-county alert names", () => {
    const zones = unresolvedZones(alertsFixture, 50);
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe("nws-alerts adapter contract", () => {
  it("credits NOAA/NWS as data, so the UI cannot forget", () => {
    expect(nwsAlerts.attribution.text).toContain("National Weather Service");
    expect(nwsAlerts.attribution.licence).toBe("public domain (US Government)");
  });

  it("polls conservatively against an unpublished rate limit", () => {
    expect(nwsAlerts.ttlSeconds).toBeGreaterThanOrEqual(60);
  });

  it("needs no API key", () => {
    expect(nwsAlerts.apiKeyEnvVar).toBeUndefined();
  });
});
