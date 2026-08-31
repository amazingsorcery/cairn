import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { Connector } from "@/db/schema";
import { flightParamsSchema, flightsDriver, FLIGHTS_CONNECTOR_SEED } from "./flights";

/**
 * The connector seam, tested without a database and without the network.
 *
 * The runtime's degraded-state machine (`runtime.ts`) reads the registry and writes the
 * audit log, both of which need Postgres — those paths are covered by
 * `scripts/verify-backend.ts` and by CI. What is covered HERE is everything that is pure:
 * parameter quantisation (which is the cache key, and therefore a privacy control), response
 * parsing and trimming, and the shape of the registry row the seed writes.
 */

/** A registry row shaped like the seeded flights connector, for the driver tests. */
const connector: Connector = {
  id: "00000000-0000-4000-8000-000000000000",
  slug: FLIGHTS_CONNECTOR_SEED.slug,
  name: FLIGHTS_CONNECTOR_SEED.name,
  kind: "flights",
  operatorName: FLIGHTS_CONNECTOR_SEED.operatorName,
  homepageUrl: FLIGHTS_CONNECTOR_SEED.homepageUrl,
  termsUrl: FLIGHTS_CONNECTOR_SEED.termsUrl,
  attribution: FLIGHTS_CONNECTOR_SEED.attribution,
  attributionRequired: true,
  legalBasis: FLIGHTS_CONNECTOR_SEED.legalBasis,
  baseUrl: FLIGHTS_CONNECTOR_SEED.baseUrl,
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 20,
  globalCeiling: 60,
  windowSeconds: 60,
  timeoutMs: 5000,
  cacheTtlSeconds: 15,
  staleWhileRevalidateSeconds: 60,
  /* Migration 0006 / ADR 0021: the flights connector is still fetched in the request path. */
  pollMode: "onDemand",
  enabled: true,
  status: "published",
  lastCheckedAt: new Date("2026-08-31T00:00:00Z"),
  notes: null,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("flight parameter quantisation", () => {
  it("rounds coordinates to one decimal place", () => {
    // ADR 0014 §4: one shared cache entry per connector plus normalised params, never per
    // user. Full precision would give every viewer their own entry, multiply upstream calls
    // by the viewer count, and recreate a per-user record of which patch of the world each
    // person was watching.
    const p = flightsDriver.normalise({ lat: 51.50735, lon: -0.12776, radius: 30 });
    expect(p.lat).toBe(51.5);
    expect(p.lon).toBe(-0.1);
  });

  it("snaps the radius up to the documented ladder", () => {
    expect(flightsDriver.normalise({ lat: 0, lon: 0, radius: 1 }).radius).toBe(25);
    expect(flightsDriver.normalise({ lat: 0, lon: 0, radius: 26 }).radius).toBe(50);
    expect(flightsDriver.normalise({ lat: 0, lon: 0, radius: 200 }).radius).toBe(250);
  });

  it("clamps to the upstream's documented maximum of 250 nautical miles", () => {
    expect(() => flightsDriver.normalise({ lat: 0, lon: 0, radius: 5000 })).toThrow();
    expect(flightsDriver.normalise({ lat: 0, lon: 0, radius: 250 }).radius).toBe(250);
  });

  it("rejects coordinates outside the globe", () => {
    expect(() => flightsDriver.normalise({ lat: 91, lon: 0 })).toThrow();
    expect(() => flightsDriver.normalise({ lat: 0, lon: 181 })).toThrow();
    expect(() => flightsDriver.normalise({ lat: "north", lon: 0 })).toThrow();
  });

  it("accepts string parameters, because they arrive from a query string", () => {
    const p = flightsDriver.normalise({ lat: "51.5", lon: "-0.12", radius: "50" });
    expect(p).toEqual({ lat: 51.5, lon: -0.1, radius: 50 });
  });

  it("defaults the radius when it is absent", () => {
    expect(flightParamsSchema.parse({ lat: 0, lon: 0 }).radius).toBe(50);
  });

  it("produces the same cache key for two nearby viewports", () => {
    // The point of the quantisation: two readers looking at London share one upstream call.
    const a = flightsDriver.cacheKey(flightsDriver.normalise({ lat: 51.5073, lon: -0.1277 }));
    const b = flightsDriver.cacheKey(flightsDriver.normalise({ lat: 51.5119, lon: -0.1201 }));
    expect(a).toBe(b);
  });

  it("produces a cache key that encodes nothing about the caller", () => {
    const key = flightsDriver.cacheKey(flightsDriver.normalise({ lat: 51.5, lon: -0.1 }));
    expect(key).toBe("51.5,-0.1,50");
    expect(key).not.toMatch(/[a-z@]/i);
  });
});

describe("flights driver fetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const respond = (body: unknown, status = 200) => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  };

  const params = { lat: 51.5, lon: -0.1, radius: 50 };
  const signal = new AbortController().signal;

  it("builds the documented path from bounded numbers", async () => {
    respond({ ac: [], now: 1, total: 0 });
    await flightsDriver.fetch(connector, params, signal);
    const call = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    expect(call?.[0]).toBe("https://api.adsb.lol/v2/lat/51.5/lon/-0.1/dist/50");
  });

  it("trims the payload to the fields the surface renders (ADR 0014 §7)", async () => {
    respond({
      ac: [
        {
          hex: "407e7b",
          flight: "TOM7AX  ",
          r: "G-TUMX",
          t: "B38M",
          lat: 51.6,
          lon: -0.54,
          alt_baro: 20650,
          gs: 341.6,
          track: 306.67,
          squawk: "5504",
          emergency: "none",
          seen_pos: 0.138,
          // Fields we deliberately do not keep.
          rssi: -14.2,
          nav_qnh: 1013.6,
          oat: -27,
          messages: 1,
          mlat: [],
          tisb: [],
          seen: 0.1,
          type: "adsb_icao",
        },
      ],
      now: 1788140483000,
      total: 1,
    });

    const { data } = await flightsDriver.fetch(connector, params, signal);
    expect(data.aircraft).toHaveLength(1);
    const [aircraft] = data.aircraft;
    expect(aircraft).toEqual({
      hex: "407e7b",
      callsign: "TOM7AX",
      registration: "G-TUMX",
      type: "B38M",
      lat: 51.6,
      lon: -0.54,
      altitudeFt: 20650,
      onGround: false,
      groundSpeedKt: 341.6,
      trackDeg: 306.67,
      squawk: "5504",
      emergency: null,
      positionAgeSeconds: 0.138,
    });
    // The discarded upstream fields really are discarded.
    expect(Object.keys(aircraft ?? {})).not.toContain("rssi");
    expect(Object.keys(aircraft ?? {})).not.toContain("oat");
  });

  it("reads the literal 'ground' altitude as onGround with a null altitude", async () => {
    respond({ ac: [{ hex: "abc123", lat: 1, lon: 2, alt_baro: "ground" }], now: 1, total: 1 });
    const { data } = await flightsDriver.fetch(connector, params, signal);
    expect(data.aircraft[0]?.onGround).toBe(true);
    expect(data.aircraft[0]?.altitudeFt).toBeNull();
  });

  it("surfaces a real emergency and suppresses the 'none' sentinel", async () => {
    respond({
      ac: [
        { hex: "a", lat: 1, lon: 2, emergency: "none" },
        { hex: "b", lat: 3, lon: 4, emergency: "general" },
      ],
      now: 1,
      total: 2,
    });
    const { data } = await flightsDriver.fetch(connector, params, signal);
    expect(data.aircraft[0]?.emergency).toBeNull();
    expect(data.aircraft[1]?.emergency).toBe("general");
  });

  it("drops aircraft with no position rather than rendering them at 0,0", async () => {
    respond({
      ac: [
        { hex: "a", lat: 1, lon: 2 },
        { hex: "b" },
        { hex: "c", lat: null, lon: null },
      ],
      now: 1,
      total: 3,
    });
    const { data } = await flightsDriver.fetch(connector, params, signal);
    expect(data.aircraft).toHaveLength(1);
    // `reportedTotal` keeps the upstream's own count, so the difference is visible.
    expect(data.reportedTotal).toBe(3);
  });

  it("tolerates unknown upstream fields (an added field must not break us)", async () => {
    respond({
      ac: [{ hex: "a", lat: 1, lon: 2, some_future_field: "whatever" }],
      now: 1,
      total: 1,
      another_new_envelope_field: true,
    });
    const { data } = await flightsDriver.fetch(connector, params, signal);
    expect(data.aircraft).toHaveLength(1);
  });

  it("throws UpstreamStatusError carrying the status on a non-2xx", async () => {
    respond({ detail: "nope" }, 503);
    await expect(flightsDriver.fetch(connector, params, signal)).rejects.toMatchObject({
      name: "UpstreamStatusError",
      status: 503,
    });
  });

  it("treats a changed response shape as an upstream fault, not a crash", async () => {
    // A free community service can change shape without notice. The surface must degrade,
    // not render half a map — and the parse error must not be surfaced, since it would
    // contain the upstream body.
    respond({ aircraft: "not what we expect" });
    await expect(flightsDriver.fetch(connector, params, signal)).rejects.toMatchObject({
      name: "UpstreamStatusError",
      status: 502,
    });
  });

  it("never sends anything about the viewer upstream", async () => {
    respond({ ac: [], now: 1, total: 0 });
    await flightsDriver.fetch(connector, params, signal);
    const call = (
      globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }
    ).mock.calls[0];
    const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase()).sort()).toEqual([
      "accept",
      "user-agent",
    ]);
    expect(call?.[1]?.cache).toBe("no-store");
    // No cookie, no forwarded-for, no referer, nothing identifying the reader.
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("cookie");
    expect(JSON.stringify(headers).toLowerCase()).not.toContain("forwarded");
  });
});

describe("the seeded flights registry row", () => {
  const seed = FLIGHTS_CONNECTOR_SEED;

  it("is inert until an operator turns it on (ADR 0012 §1, fail closed)", () => {
    expect(seed.enabled).toBe(false);
    expect(seed.status).toBe("draft");
  });

  it("records a legal basis, a terms URL and an attribution string", () => {
    // ADR 0011 rule 1: a connector with no recorded basis does not ship. The database
    // enforces it; this asserts the seed does not try to ship one.
    expect(seed.termsUrl).toBeTruthy();
    expect(seed.legalBasis.length).toBeGreaterThan(200);
    expect(seed.attributionRequired).toBe(true);
    expect(seed.attribution).toBeTruthy();
  });

  it("names the licence it was read under, and dates the reading", () => {
    expect(seed.legalBasis).toContain("ODbL");
    expect(seed.legalBasis).toContain("2026-08-31");
    expect(seed.legalBasis).toContain("NOT A LEGAL OPINION");
  });

  it("stores no credential and needs none today", () => {
    // ADR 0012 §3: the registry stores the NAME of an env var, never the credential. The
    // CHECK constraint enforces the pattern; this asserts the seed does not smuggle one in.
    expect(seed.requiresApiKey).toBe(false);
    expect(seed.apiKeyEnvVar).toBeNull();
  });

  it("keeps the global ceiling above the per-user quota", () => {
    expect(seed.globalCeiling).toBeGreaterThanOrEqual(seed.perUserQuota);
  });

  /**
   * These pin the OUTCOME of QA finding Q-02, not ADR 0014's original starting values. ADR
   * 0014 §2 called those "starting values, to be tuned against real upstream behaviour rather
   * than guessed at twice"; the audit log — 57 HTTP 429s, 29% of all calls refused — was the
   * measurement, and these are the tuning.
   */
  it("caches long enough that one viewport cannot exceed one call per minute", () => {
    // The single biggest reduction in upstream load available: at a 15s TTL one viewport cost
    // 4 calls/minute, which is most of the old ceiling on its own.
    expect(seed.cacheTtlSeconds).toBeGreaterThanOrEqual(60);
    expect(seed.timeoutMs).toBe(5000);
  });

  it("keeps a stale payload well past the TTL so a backoff does not blank the surface", () => {
    // While we are backed off we would rather show old positions clearly labelled with their
    // age than an empty page (ADR 0014 §3 still bounds it at ttl + swr).
    expect(seed.staleWhileRevalidateSeconds).toBeGreaterThanOrEqual(
      seed.cacheTtlSeconds * 5,
    );
  });

  it("sets a ceiling below the rate at which the upstream was observed to refuse us", () => {
    // Measured 2026-08-31: a 25-request burst was refused from the 3rd request, and a smooth
    // 10 requests/minute still drew 2 refusals in 8. Anything at or above 10/min is known to
    // be refused, so the ceiling must sit under it — with room, because the bucket's state
    // depends on load we cannot see.
    expect(seed.globalCeiling).toBeLessThanOrEqual(6);
    expect(seed.perUserQuota).toBeLessThanOrEqual(seed.globalCeiling);
    expect(seed.windowSeconds).toBe(60);
  });

  it("records that the upstream's limiter is the authority, not our columns", () => {
    // The defect Q-02 actually named: the previous legal_basis claimed we called "at a rate
    // bounded by the columns on this row", and the audit log proved that false. A false
    // statement in the connector registry is worse than the rate-limiting itself, for a
    // product whose whole thesis is that its records are accurate.
    expect(seed.legalBasis).toMatch(/THEIR LIMITER IS THE AUTHORITY AND NOT THESE COLUMNS/);
    expect(seed.legalBasis).toContain("429");
    expect(seed.legalBasis).toContain("cooldown");
    expect(seed.legalBasis).not.toMatch(/at a rate bounded by the columns on this row/);
  });
});
