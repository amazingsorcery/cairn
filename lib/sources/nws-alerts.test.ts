import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryCache } from "./cache";
import { representativePoint } from "./geometry";
import { resetSourceRuntime } from "./http";
import {
  clearZoneCache,
  normaliseNwsAlerts,
  nwsAlerts,
  nwsAlertsResponseSchema,
  nwsZoneResponseSchema,
  primeZoneCache,
  unresolvedZones,
  zoneCacheSize,
} from "./nws-alerts";

/** Both fixtures are real payloads captured from api.weather.gov on 2026-08-31, unedited. */
import alertsFixture from "./__fixtures__/nws-alerts.json";
import zoneFixture from "./__fixtures__/nws-zone.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

/**
 * The captured zone is `AZZ004`, Kaibab Plateau, Arizona — chosen because it is the first
 * zone the alerts fixture needs and cannot place on its own. (Pima County, the other obvious
 * candidate, turned out to belong to an alert that already carries a polygon, so priming it
 * proved nothing. Worth recording: the first version of this test passed for the wrong reason.)
 */
function zonePoint(): { longitude: number; latitude: number; name: string | null } {
  const parsed = nwsZoneResponseSchema.parse(zoneFixture);
  const point = representativePoint(parsed.geometry);
  if (!point) throw new Error("captured zone fixture should have geometry");
  return { ...point, name: parsed.properties.name ?? null };
}

beforeEach(() => {
  clearZoneCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
  clearZoneCache();
});

describe("nws-alerts normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const features = normaliseNwsAlerts(alertsFixture, {});

    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("weather");
      expect(Number.isFinite(feature.longitude)).toBe(true);
      expect(Number.isFinite(feature.latitude)).toBe(true);
      expect(feature.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("places a zone-only alert once its zone is resolved, and says the point is a zone centroid", () => {
    // The reason this adapter is more than a GeoJSON pass-through: on 2026-08-31 only 2 of
    // the 15 alerts in this fixture carried a polygon.
    const before = normaliseNwsAlerts(alertsFixture, {});

    primeZoneCache("AZZ004", zonePoint());
    const after = normaliseNwsAlerts(alertsFixture, {});

    expect(after.length).toBeGreaterThan(before.length);

    const placed = after.find((f) => f.properties.locationBasis === "zone");
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
    const fromPolygon = normaliseNwsAlerts(alertsFixture, {}).filter(
      (f) => f.properties.locationBasis === "polygon",
    );
    expect(fromPolygon.length).toBeGreaterThan(0);
    expect(fromPolygon.every((f) => f.properties.zoneCode === null)).toBe(true);
  });

  it("applies a viewport, because the endpoint returns all active US alerts", () => {
    primeZoneCache("AZZ004", zonePoint());
    const all = normaliseNwsAlerts(alertsFixture, {});
    const arizona = normaliseNwsAlerts(alertsFixture, {
      bbox: { west: -115, south: 34, east: -109, north: 37 },
    });
    expect(arizona.length).toBeLessThan(all.length);
    expect(arizona.length).toBeGreaterThan(0);
  });

  it("applies a limit", () => {
    primeZoneCache("AZZ004", zonePoint());
    expect(normaliseNwsAlerts(alertsFixture, { limit: 1 })).toHaveLength(1);
  });
});

describe("nws-alerts schema", () => {
  it("accepts the captured payload", () => {
    expect(nwsAlertsResponseSchema.safeParse(alertsFixture).success).toBe(true);
  });

  it("rejects a document that would otherwise read as 'no weather warnings anywhere'", () => {
    // The decision is made by the SCHEMA in `fetch`. `updated` and `features` are required
    // for exactly this reason.
    expect(nwsAlertsResponseSchema.safeParse({ status: 503, detail: "unavailable" }).success).toBe(
      false,
    );
    expect(
      nwsAlertsResponseSchema.safeParse({ type: "FeatureCollection", features: [] }).success,
    ).toBe(false);
  });
});

describe("nws-alerts zone warm-up", () => {
  it("is bounded per poll, so a cold start is not a 700-request burst", () => {
    // The lesson from QA finding Q-02: our own limiter must never allow a burst just
    // because the upstream has not published a number.
    expect(unresolvedZones(alertsFixture, 3).length).toBeLessThanOrEqual(3);
  });

  it("never re-requests a zone already known, including a cached miss", () => {
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

describe("nws-alerts shared zone cache", () => {
  it("writes resolved zones to the context cache rather than to a map of its own", async () => {
    const cache = createMemoryCache();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/zones/")) return Promise.resolve(jsonResponse(zoneFixture));
      return Promise.resolve(jsonResponse(alertsFixture));
    });

    await nwsAlerts.fetch({}, testContext({ cache }));
    expect(zoneCacheSize()).toBeGreaterThan(0);
    expect(await cache.get("source:nws-alerts:zone-points")).toContain("AZZ004");
  });

  it("re-warms from the context cache instead of starting cold when its own view is lost", async () => {
    const cache = createMemoryCache();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/zones/")) return Promise.resolve(jsonResponse(zoneFixture));
      return Promise.resolve(jsonResponse(alertsFixture));
    });
    const zoneCalls = () => spy.mock.calls.filter((c) => String(c[0]).includes("/zones/")).length;

    await nwsAlerts.fetch({}, testContext({ cache }));
    const firstPollCalls = zoneCalls();
    // The per-poll cap, doing its job on a cold start.
    expect(firstPollCalls).toBe(12);

    /*
     * The adapter's own per-call view is dropped while the passed-in cache is kept — which
     * is what happens between polls, not what happens across a restart. `SourceContext.cache`
     * is a per-process map (ADR 0031 removed the shared store), so a real restart empties
     * both and the layer re-warms over several polls. See docs/sources/HANDOFF.md §4.
     */
    clearZoneCache();
    expect(zoneCacheSize()).toBe(0);

    await nwsAlerts.fetch({}, testContext({ cache }));
    const restartCalls = zoneCalls() - firstPollCalls;

    // THE POINT OF THE SHARED CACHE. A poll must not re-resolve what was already
    // resolved. The one remaining call is the warm-up continuing to the 13th zone the
    // fixture names — progress, not repetition.
    expect(restartCalls).toBeLessThanOrEqual(1);
    expect(zoneCacheSize()).toBeGreaterThanOrEqual(12);
  });

  it("starts cold with a fresh cache — which is what every restart costs", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes("/zones/") ? zoneFixture : alertsFixture),
      ),
    );
    const zoneCalls = () => spy.mock.calls.filter((c) => String(c[0]).includes("/zones/")).length;

    // A fresh cache each poll is what a deploy gives us, and what an adapter-owned map gave
    // us every poll before the cache was passed in.
    await nwsAlerts.fetch({}, testContext({ cache: createMemoryCache() }));
    const firstPollCalls = zoneCalls();
    clearZoneCache();

    await nwsAlerts.fetch({}, testContext({ cache: createMemoryCache() }));
    // Twelve calls spent re-learning what it already knew, every restart, for half an hour.
    expect(zoneCalls() - firstPollCalls).toBe(firstPollCalls);
  });

  it("treats an unreadable cache entry as a cold start rather than an error", async () => {
    const cache = createMemoryCache();
    await cache.set("source:nws-alerts:zone-points", "{not json");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes("/zones/") ? zoneFixture : alertsFixture),
      ),
    );

    const result = await nwsAlerts.fetch({}, testContext({ cache }));
    expect(result.ok).toBe(true);
  });
});

describe("nws-alerts fetch", () => {
  it("takes observedAt from the collection's own `updated`, not our clock", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(alertsFixture));

    const result = await nwsAlerts.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observedAt.toISOString()).toBe(new Date(alertsFixture.updated).toISOString());
  });

  it("returns schemaChanged rather than throwing when the shape moves", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ status: 503 }));

    const result = await nwsAlerts.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
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
