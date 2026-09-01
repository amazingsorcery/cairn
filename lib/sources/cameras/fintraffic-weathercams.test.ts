import { describe, expect, it } from "vitest";

import { fintrafficWeathercams } from "./fintraffic-weathercams";
import { CAMERA_STILL_IMAGE_ORIGINS } from "./origins";
import { toCameraFeature } from "./provider";

/**
 * REAL PAYLOAD, NOT AN INVENTED ONE.
 *
 * 26 stations captured verbatim from
 * `https://tie.digitraffic.fi/api/weathercam/v1/stations` on 2026-09-01, out of 812 in the
 * full response, chosen to include the awkward cases a made-up fixture would not have:
 * three stations with `collectionStatus: "REMOVED_TEMPORARILY"`, and four presets with
 * `inCollection: false`. The GeoJSON coordinates carry a third element (always 0), which is
 * exactly the sort of thing that breaks a hand-written schema.
 */
import fixture from "../__fixtures__/fintraffic-weathercams.json";

const READ_AT = new Date("2026-09-01T16:52:00Z");

function read() {
  const result = fintrafficWeathercams.read(fixture, READ_AT);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
}

const presetCount = fixture.features.reduce(
  (total, station) => total + station.properties.presets.length,
  0,
);

describe("fintraffic-weathercams", () => {
  it("emits one camera per preset, not one per station", () => {
    // A station is a mast; a preset is a camera view with its own image URL. Collapsing them
    // would throw away two thirds of the published views and pick one arbitrarily.
    const { records } = read();
    expect(records).toHaveLength(presetCount);
    expect(records.length).toBeGreaterThan(fixture.features.length);
  });

  it("keeps presets and stations Fintraffic reports as out, flagged rather than hidden", () => {
    const { records } = read();
    const unavailable = records.filter((record) => !record.available);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable.length).toBeLessThan(records.length);
  });

  it("is stills only, and says so rather than inventing a video URL", () => {
    /*
     * Digitraffic's road-traffic documentation describes exactly one media form for
     * weathercams, and their OpenAPI document publishes no video or HLS endpoint for them.
     * A plausible `.mp4` alongside the `.jpg` would be a fabricated URL on a shipped path.
     */
    const { records } = read();
    for (const record of records) {
      expect(record.media.still).not.toBeNull();
      expect(record.media.video).toBeNull();
      expect(record.media.stream).toBeNull();
    }
  });

  it("builds the documented image URL for each preset", () => {
    // "For example preset image C1451601 is located at
    // https://weathercam.digitraffic.fi/C1451601.jpg" — digitraffic.fi/en/road-traffic/.
    const { records } = read();
    for (const record of records) {
      expect(record.media.still?.url).toBe(
        `https://weathercam.digitraffic.fi/${record.id}.jpg`,
      );
      expect(CAMERA_STILL_IMAGE_ORIGINS).toContain(
        new URL(String(record.media.still?.url)).origin,
      );
    }
  });

  it("carries Fintraffic's documented ten-minute cadence", () => {
    const { records } = read();
    for (const record of records) expect(record.media.still?.refreshSeconds).toBe(600);
  });

  it("reads the station name without translating or expanding it", () => {
    const { records } = read();
    // `kt51_Inkoo` -> `kt51 Inkoo (view 01)`. The underscore is a separator; the road-class
    // abbreviation is Fintraffic's and is left as they write it.
    expect(records.some((record) => record.name.includes("kt51 Inkoo"))).toBe(true);
    for (const record of records) expect(record.name).not.toContain("_");
  });

  it("infers no direction from a preset id", () => {
    /*
     * `directionCode` exists — on the per-station DETAIL endpoint, which this adapter does
     * not call. Reading "towards Inkoo" out of the digits of `C0150301` would be inventing a
     * fact about which way a camera points, across 812 stations.
     */
    const { records } = read();
    for (const record of records) {
      expect(record.name).not.toMatch(/towards|north|south|east|west/i);
      expect(record.subject).toBe("road weather");
    }
  });

  it("reads the coordinate in GeoJSON order, longitude first", () => {
    const { records } = read();
    for (const record of records) {
      // Finland. Swapping the pair would put every one of them in the Indian Ocean.
      expect(record.latitude).toBeGreaterThan(59);
      expect(record.latitude).toBeLessThan(71);
      expect(record.longitude).toBeGreaterThan(19);
      expect(record.longitude).toBeLessThan(32);
    }
  });

  it("reports Fintraffic's own dataUpdatedTime, not our clock", () => {
    expect(read().observedAt.toISOString()).toBe(
      new Date(fixture.dataUpdatedTime).toISOString(),
    );
  });

  it("disables itself, and only itself, when the payload changes shape", () => {
    const result = fintrafficWeathercams.read(
      { type: "FeatureCollection", features: [{ type: "Feature", id: "C1" }] },
      READ_AT,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
    expect(result.failure.message).toContain("fintraffic-weathercams");
  });

  it("builds a feature that names its only media form", () => {
    const { records } = read();
    const first = records[0];
    expect(first).toBeDefined();
    if (!first) return;
    const feature = toCameraFeature(fintrafficWeathercams, first, {
      lastVerifiedAt: "2026-09-01",
      confidence: "verified",
    });
    expect(feature?.properties.mediaForms).toBe("still");
    expect(feature?.properties.hasLiveStream).toBe(false);
    expect(feature?.properties.videoUrl).toBeNull();
    expect(feature?.properties.attribution).toBe(
      "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
    );
    expect(feature?.properties.attributionRequired).toBe(true);
  });
});
