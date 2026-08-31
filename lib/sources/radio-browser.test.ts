import { describe, expect, it } from "vitest";

import { normaliseRadioBrowser, pickServer, radioBrowser } from "./radio-browser";

/**
 * Real payload: the 200 most-clicked geolocated stations, captured from
 * de1.api.radio-browser.info on 2026-08-31, unedited.
 */
import fixture from "./__fixtures__/radio-browser.json";

describe("radio-browser normalise", () => {
  it("maps the captured live payload to renderable features", () => {
    const result = normaliseRadioBrowser(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      expect(feature.kind).toBe("radio");
      expect(feature.label).not.toBe("");
      expect(feature.properties.streamUrl).toMatch(/^https?:\/\//);
    }
  });

  it("hands the client a direct stream URL, which our server never fetches", () => {
    // The rule that decides the whole build (product-brief §2b). If this ever becomes a
    // path on our own origin, the product has started rebroadcasting.
    const result = normaliseRadioBrowser(fixture);
    if (!result.ok) throw new Error("fixture should parse");
    for (const feature of result.features) {
      expect(feature.properties.streamUrl).not.toMatch(/^\/(api|proxy)/);
      expect(new URL(feature.properties.streamUrl).hostname).not.toBe("localhost");
    }
  });

  it("refuses a stream URL that is not http(s)", () => {
    const result = normaliseRadioBrowser([
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
    ]);
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features.map((f) => f.id)).toEqual(["c"]);
  });

  it("drops stations left at 0,0 rather than pinning a fleet of radios in the Gulf of Guinea", () => {
    const result = normaliseRadioBrowser([
      { stationuuid: "null-island", name: "Nowhere FM", url_resolved: "https://example.com/a", geo_lat: 0, geo_long: 0 },
      { stationuuid: "real", name: "Somewhere FM", url_resolved: "https://example.com/b", geo_lat: 1, geo_long: 1 },
    ]);
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features.map((f) => f.id)).toEqual(["real"]);
  });

  it("drops stations with no coordinates", () => {
    const result = normaliseRadioBrowser([
      { stationuuid: "nogeo", name: "No Geo FM", url_resolved: "https://example.com/a" },
    ]);
    if (!result.ok) throw new Error("payload should parse");
    expect(result.features).toEqual([]);
  });

  it("returns schemaChanged rather than throwing when the shape moves", () => {
    const result = normaliseRadioBrowser({ error: "not an array" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("uses our receive time for observedAt, because a bare array carries no upstream clock", () => {
    const at = new Date("2026-08-31T12:00:00Z");
    const result = normaliseRadioBrowser(fixture, at);
    if (!result.ok) throw new Error("fixture should parse");
    expect(result.observedAt).toBe(at);
  });
});

describe("radio-browser server discovery", () => {
  it("only ever accepts hostnames inside the project's own domain", () => {
    // The discovery response is remote-controlled text going into a server-side fetch URL:
    // the SSRF shape ADR 0019 calls v2's top risk.
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
