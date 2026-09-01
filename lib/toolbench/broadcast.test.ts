import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  broadcastFilterSchema,
  buildSearchParams,
  countInsecure,
  DEFAULT_RESULTS,
  filtersCacheKey,
  hasAnyFilter,
  MAX_RESULTS,
  normaliseBroadcast,
  parseTags,
  safeStreamUrl,
  SEARCH_ORDERS,
} from "./broadcast";

/**
 * A REAL captured response, not an invented one.
 *
 * `lib/toolbench/__fixtures__/radio-browser-search.json` was captured on 2026-09-01 from
 * `https://all.api.radio-browser.info/json/stations/search?countrycode=NL&language=dutch&limit=12&order=votes&reverse=true&hidebroken=true`.
 *
 * Two properties of it are asserted below because they are the two findings this whole tool
 * is built around, and an invented fixture would have contained neither:
 *
 *   - **9 of the 12 stream over plain `http:`.** They cannot play on an HTTPS page.
 *   - **2 of the 12 carry coordinates.** The map adapter's `has_geo_info=true` filter would
 *     show two of these twelve, including neither of the national news networks.
 */
const fixture: unknown = JSON.parse(
  readFileSync(join(process.cwd(), "lib", "toolbench", "__fixtures__", "radio-browser-search.json"), "utf8"),
);

const defaults = broadcastFilterSchema.parse({});

describe("the captured catalogue response", () => {
  it("parses every station in a real payload", () => {
    const result = normaliseBroadcast(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(12);
  });

  /**
   * The number that decides the UI. 9 of 12 here; the integrations engineer measured about
   * 20% across the geolocated subset. Either way, a play button on one of these fails
   * silently — nothing errors, no console message, the reader concludes the tool is broken.
   */
  it("flags the plain-http streams a browser will block as mixed content", () => {
    const result = normaliseBroadcast(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countInsecure(result.value)).toBe(9);
    for (const station of result.value) {
      expect(station.isInsecureStream).toBe(station.streamUrl.startsWith("http://"));
    }
  });

  /**
   * The reason this tool does not use `lib/sources/radio-browser.ts`. That adapter passes
   * `has_geo_info=true`; on this real result set that leaves two stations out of twelve,
   * and it drops NPO Radio 1 — the Dutch national news network, and the single most obvious
   * answer to "what is on the radio in the Netherlands".
   */
  it("returns stations with no coordinates, which the map adapter cannot", () => {
    const result = normaliseBroadcast(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const geolocated = result.value.filter((station) => station.latitude !== null);
    expect(geolocated.length).toBe(2);

    const npo = result.value.find((station) => station.name.includes("NPO Radio 1"));
    expect(npo, "NPO Radio 1 is in the catalogue").toBeDefined();
    expect(npo?.latitude, "and it has no coordinates, so a map-shaped query loses it").toBeNull();
  });

  it("reads codec, bitrate and the project's own last-checked signal", () => {
    const result = normaliseBroadcast(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const withBitrate = result.value.filter((station) => station.bitrateKbps !== null);
    expect(withBitrate.length).toBeGreaterThan(0);
    const withCheck = result.value.filter((station) => station.lastCheckedAt !== null);
    expect(withCheck.length).toBeGreaterThan(0);
  });

  it("fails rather than reporting an empty catalogue when the shape changes", () => {
    expect(normaliseBroadcast({ stations: [] }).ok).toBe(false);
    expect(normaliseBroadcast("<html>502</html>").ok).toBe(false);
    expect(normaliseBroadcast(null).ok).toBe(false);
  });

  it("reports an empty result honestly when the search really matched nothing", () => {
    const result = normaliseBroadcast([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(0);
  });
});

describe("stream URLs", () => {
  it("takes http and https and refuses everything else", () => {
    expect(safeStreamUrl("https://stream.example/aac")).toBe("https://stream.example/aac");
    expect(safeStreamUrl("http://stream.example/mp3")).toBe("http://stream.example/mp3");
    expect(safeStreamUrl("javascript:alert(1)")).toBeNull();
    expect(safeStreamUrl("data:audio/mpeg;base64,AAAA")).toBeNull();
    expect(safeStreamUrl("file:///etc/passwd")).toBeNull();
    expect(safeStreamUrl("not a url")).toBeNull();
    expect(safeStreamUrl(null, undefined, "")).toBeNull();
  });

  /**
   * A catalogue anybody can edit is a place where a credentialled URL can be planted, and
   * this list is rendered into href and src attributes that the browser will then send.
   */
  it("refuses a URL carrying credentials", () => {
    expect(safeStreamUrl("https://user:pass@stream.example/aac")).toBeNull();
  });

  it("prefers the resolved URL, which has already followed playlist redirects", () => {
    const result = normaliseBroadcast([
      {
        stationuuid: "a",
        name: "Test",
        url: "https://example.test/playlist.pls",
        url_resolved: "https://example.test/stream.aac",
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]?.streamUrl).toBe("https://example.test/stream.aac");
  });

  it("drops a station with no usable URL rather than rendering a dead play button", () => {
    const result = normaliseBroadcast([
      { stationuuid: "a", name: "No stream", url: null, url_resolved: null },
      { stationuuid: "b", name: "Bad scheme", url: "javascript:void(0)", url_resolved: null },
      { stationuuid: "c", name: "Fine", url_resolved: "https://example.test/s" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((station) => station.uuid)).toEqual(["c"]);
  });
});

describe("filters", () => {
  it("never sends has_geo_info, which is the whole point", () => {
    const params = buildSearchParams(broadcastFilterSchema.parse({ countryCode: "ua" }));
    expect(params.has("has_geo_info")).toBe(false);
    expect(params.get("countrycode")).toBe("UA");
  });

  it("percent-encodes a search term rather than letting it become URL syntax", () => {
    const params = buildSearchParams(
      broadcastFilterSchema.parse({ name: "radio & noise=1", tag: "News Talk" }),
    );
    expect(params.toString()).toContain("name=radio+%26+noise%3D1");
    expect(params.get("tag")).toBe("news talk");
  });

  it("refuses a control character in a search term", () => {
    expect(broadcastFilterSchema.safeParse({ name: "radio\u0000one" }).success).toBe(false);
    expect(broadcastFilterSchema.safeParse({ name: "radio\u0007one" }).success).toBe(false);
    expect(broadcastFilterSchema.safeParse({ name: "radio\none" }).success).toBe(false);
    // An ordinary space is fine; it is the invisible control characters that are not.
    expect(broadcastFilterSchema.safeParse({ name: "radio one" }).success).toBe(true);
  });

  it("refuses a country code that is not two letters", () => {
    expect(broadcastFilterSchema.safeParse({ countryCode: "NLD" }).success).toBe(false);
    expect(broadcastFilterSchema.safeParse({ countryCode: "N1" }).success).toBe(false);
    expect(broadcastFilterSchema.safeParse({ countryCode: "" }).success).toBe(true);
  });

  it("clamps the result count to the ceiling", () => {
    expect(broadcastFilterSchema.safeParse({ limit: MAX_RESULTS + 1 }).success).toBe(false);
    expect(broadcastFilterSchema.parse({}).limit).toBe(DEFAULT_RESULTS);
  });

  it("only accepts an allowlisted ordering", () => {
    for (const order of SEARCH_ORDERS) {
      expect(broadcastFilterSchema.safeParse({ order }).success, order).toBe(true);
    }
    expect(broadcastFilterSchema.safeParse({ order: "; drop" }).success).toBe(false);
  });

  it("sorts names ascending and everything else descending", () => {
    expect(buildSearchParams(broadcastFilterSchema.parse({ order: "name" })).get("reverse")).toBe(
      "false",
    );
    expect(buildSearchParams(broadcastFilterSchema.parse({ order: "votes" })).get("reverse")).toBe(
      "true",
    );
  });

  it("knows when nothing has been asked for", () => {
    expect(hasAnyFilter(defaults)).toBe(false);
    expect(hasAnyFilter(broadcastFilterSchema.parse({ language: "ukrainian" }))).toBe(true);
  });

  /**
   * ADR 0014 §4: the cache key is the query and never the caller. Two readers asking the
   * same question must land on the same entry, and a different question must not.
   */
  it("produces the same cache key for the same query and a different one otherwise", () => {
    const a = broadcastFilterSchema.parse({ countryCode: "NL", language: "dutch" });
    const b = broadcastFilterSchema.parse({ countryCode: "nl", language: "Dutch" });
    const c = broadcastFilterSchema.parse({ countryCode: "BE", language: "dutch" });
    expect(filtersCacheKey(a)).toBe(filtersCacheKey(b));
    expect(filtersCacheKey(a)).not.toBe(filtersCacheKey(c));
  });
});

describe("tags", () => {
  it("splits the upstream's comma-separated string and caps the list", () => {
    expect(parseTags("news, talk , ,current affairs")).toEqual(["news", "talk", "current affairs"]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(","))).toHaveLength(12);
  });
});
