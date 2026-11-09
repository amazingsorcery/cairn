import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryCache } from "./cache";
import { resetSourceRuntime } from "./http";
import {
  normaliseRadioBrowser,
  pickServer,
  radioBrowser,
  radioBrowserResponseSchema,
} from "./radio-browser";

/**
 * Real payload: the 200 most-clicked geolocated stations, captured from
 * de1.api.radio-browser.info on 2026-08-31, unedited.
 */
import fixture from "./__fixtures__/radio-browser.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

describe("radio-browser normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const features = normaliseRadioBrowser(fixture, {});

    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("radio");
      expect(feature.label).not.toBe("");
      expect(feature.properties.streamUrl).toMatch(/^https?:\/\//);
    }
  });

  it("hands the client a direct stream URL, which our server never fetches", () => {
    // We never relay audio; stream URLs must not point at our own origin.
    for (const feature of normaliseRadioBrowser(fixture, {})) {
      expect(feature.properties.streamUrl).not.toMatch(/^\/(api|proxy)/);
      expect(new URL(feature.properties.streamUrl).hostname).not.toBe("localhost");
    }
  });

  it("flags the http streams a browser will block as mixed content", () => {
    /**
     * ~20% of stations use plain `http:` (34 of 200 in this fixture). Flagged rather than
     * dropped, since playback fails silently on an HTTPS page and the UI needs to know.
     */
    const features = normaliseRadioBrowser(fixture, {});
    const insecure = features.filter((f) => f.properties.isInsecureStream);

    expect(insecure.length).toBeGreaterThan(0);
    expect(insecure.length).toBeLessThan(features.length);
    for (const feature of insecure) {
      expect(feature.properties.streamUrl.startsWith("http://")).toBe(true);
    }
    for (const feature of features.filter((f) => !f.properties.isInsecureStream)) {
      expect(feature.properties.streamUrl.startsWith("https://")).toBe(true);
    }
  });

  it("refuses a stream URL that is not http(s)", () => {
    const features = normaliseRadioBrowser([
      {
        stationuuid: "a",
        name: "javascript station",
        url: "javascript:alert(1)",
        url_resolved: "javascript:alert(1)",
        geo_lat: 10,
        geo_long: 10,
      },
      {
        stationuuid: "b",
        name: "data station",
        url_resolved: "data:audio/mp3;base64,AAAA",
        geo_lat: 11,
        geo_long: 11,
      },
      { stationuuid: "c", name: "real station", url_resolved: "https://example.com/s", geo_lat: 12, geo_long: 12 },
    ], {});
    expect(features.map((f) => f.id)).toEqual(["c"]);
  });

  it("drops stations left at 0,0 rather than pinning a fleet of radios in the Gulf of Guinea", () => {
    const features = normaliseRadioBrowser([
      { stationuuid: "null-island", name: "Nowhere FM", url_resolved: "https://example.com/a", geo_lat: 0, geo_long: 0 },
      { stationuuid: "real", name: "Somewhere FM", url_resolved: "https://example.com/b", geo_lat: 1, geo_long: 1 },
    ], {});
    expect(features.map((f) => f.id)).toEqual(["real"]);
  });

  it("drops stations with no coordinates", () => {
    const features = normaliseRadioBrowser([
      { stationuuid: "nogeo", name: "No Geo FM", url_resolved: "https://example.com/a" },
    ], {});
    expect(features).toEqual([]);
  });

  it("applies a viewport, because the search endpoint has no bbox parameter", () => {
    const all = normaliseRadioBrowser(fixture, {});
    const europe = normaliseRadioBrowser(fixture, {
      bbox: { west: -10, south: 35, east: 30, north: 60 },
    });
    expect(europe.length).toBeLessThan(all.length);
    for (const feature of europe) {
      expect(feature.longitude).toBeGreaterThanOrEqual(-10);
      expect(feature.longitude).toBeLessThanOrEqual(30);
    }
  });
});

describe("radio-browser schema", () => {
  it("accepts the captured payload", () => {
    expect(radioBrowserResponseSchema.safeParse(fixture).success).toBe(true);
  });

  it("rejects a document that is not a station array", () => {
    expect(radioBrowserResponseSchema.safeParse({ error: "not an array" }).success).toBe(false);
  });
});

describe("radio-browser fetch", () => {
  it("uses our receive time for observedAt, because a bare array carries no upstream clock", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes("/servers") ? [{ name: "de1.api.radio-browser.info" }] : fixture),
      ),
    );

    const before = Date.now();
    const result = await radioBrowser.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("remembers its mirror in the shared cache rather than re-discovering every poll", async () => {
    const cache = createMemoryCache();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes("/servers") ? [{ name: "de1.api.radio-browser.info" }] : fixture),
      ),
    );
    const discoveries = () => spy.mock.calls.filter((c) => String(c[0]).includes("/servers")).length;

    await radioBrowser.fetch({}, testContext({ cache }));
    expect(discoveries()).toBe(1);

    // A second poll must not cost a second discovery call.
    await radioBrowser.fetch({}, testContext({ cache }));
    expect(discoveries()).toBe(1);
  });

  it("passes a caller's limit upstream rather than paying for bytes it will discard", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(String(input).includes("/servers") ? [{ name: "de1.api.radio-browser.info" }] : fixture),
      ),
    );

    await radioBrowser.fetch({ limit: 25 }, testContext());
    const stationCall = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/stations/"));
    expect(stationCall).toContain("limit=25");
  });
});

describe("radio-browser server discovery", () => {
  it("only ever accepts hostnames inside the project's own domain", () => {
    // Discovery returns remote-controlled text used in a server-side fetch URL (SSRF risk).
    expect(pickServer([{ name: "evil.example.com" }])).toBe("de1.api.radio-browser.info");
    expect(pickServer([{ name: "de1.api.radio-browser.info.evil.com" }])).toBe(
      "de1.api.radio-browser.info",
    );
    expect(pickServer([{ name: "de1.api.radio-browser.info" }])).toBe("de1.api.radio-browser.info");
  });

  it("falls back to the documented example server when discovery returns nonsense", () => {
    expect(pickServer({ not: "an array" })).toBe("de1.api.radio-browser.info");
    expect(pickServer([])).toBe("de1.api.radio-browser.info");
  });

  it("picks from whatever mirrors discovery offers, rather than pinning one", () => {
    const hosts = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      hosts.add(pickServer([{ name: "de1.api.radio-browser.info" }, { name: "de2.api.radio-browser.info" }]));
    }
    expect(hosts.size).toBe(2);
  });
});

describe("radio-browser adapter contract", () => {
  it("credits the catalogue even though its licence does not require it", () => {
    expect(radioBrowser.attribution.text).toContain("Radio Browser");
    expect(radioBrowser.attribution.licence).toContain("public domain");
  });

  it("polls volunteer-run mirrors like a guest", () => {
    expect(radioBrowser.ttlSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("needs no API key", () => {
    expect(radioBrowser.apiKeyEnvVar).toBeUndefined();
  });
});
