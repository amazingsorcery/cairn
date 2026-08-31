import { describe, expect, it } from "vitest";

import { LINK_ONLY_REGISTRY, normaliseCameras, trafficCameras } from "./traffic-cameras";
import { testContext } from "./__fixtures__/context";

/**
 * The "fixture" here is the committed registry itself — `content/cameras/*.json`, verified by
 * hand in v1 with licences read and URLs fetched. It is real content, not a capture of a live
 * response, because this adapter makes no live request (ADR 0015).
 */

describe("traffic-cameras", () => {
  it("serves the verified registry as renderable features", async () => {
    const result = await trafficCameras.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.features.length).toBeGreaterThan(0);
    for (const feature of result.features) {
      expect(feature.kind).toBe("cameras");
      expect(feature.properties.embedUrl).toMatch(/^https:\/\//);
      expect(feature.properties.licence).not.toBe("");
    }
  });

  it("carries a per-camera attribution, because two licences cannot share one string", async () => {
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("registry should parse");

    // TfL's terms require their exact wording including the Ordnance Survey notice; CC BY
    // requires Fintraffic's. A blended layer-level string would satisfy neither licence.
    for (const feature of result.features) {
      if (feature.properties.attributionRequired) {
        expect(feature.properties.attribution).toBeTruthy();
      }
    }
    const strings = new Set(result.features.map((f) => f.properties.attribution));
    expect(strings.size).toBeGreaterThan(1);
  });

  it("excludes link-only providers, whose embed permission was never confirmed", async () => {
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("registry should parse");

    // The separate file exists precisely because an embed permission could not be confirmed.
    // Rendering those on an embedding layer would undo that judgement.
    expect(normaliseCameras([LINK_ONLY_REGISTRY], {})).toEqual([]);

    const ids = new Set(result.features.map((f) => f.id));
    expect(ids.has("statens-vegvesen-webkamera-network")).toBe(false);
  });

  it("never hands out a camera it may not embed, even if one appeared in an embedding file", () => {
    const features = normaliseCameras([
      {
        provider: { slug: "p", name: "Provider", attribution: "credit", licence: "test" },
        cameras: [
          {
            slug: "not-permitted",
            name: "Not permitted",
            operator: "op",
            jurisdiction: "GB",
            locationLabel: "somewhere",
            latitude: 51,
            longitude: 0,
            sourceUrl: "https://example.com",
            embedUrl: "https://example.com/a.jpg",
            embedPermitted: false,
            attributionRequired: true,
            attribution: "credit",
            licence: "test",
            subject: "traffic",
            confidence: "verified",
            lastVerifiedAt: "2026-08-31",
          },
        ],
      },
    ], {});
    expect(features).toEqual([]);
  });

  it("reports the date a human verified the entry, not the moment it ran", async () => {
    // A static registry that claims to have been observed just now is lying about its age,
    // which is the freshness failure ADR 0014 exists to prevent.
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("registry should parse");
    expect(result.observedAt.getTime()).toBeLessThan(Date.now());
    expect(result.observedAt.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("degrades rather than throwing if the registry stops matching its schema", () => {
    const broken = [{ provider: {}, cameras: "not an array" }];
    expect(trafficCameras.responseSchema.safeParse(broken).success).toBe(false);
    expect(normaliseCameras(broken, {})).toEqual([]);
  });

  it("applies a viewport", async () => {
    const all = await trafficCameras.fetch({}, testContext());
    const london = await trafficCameras.fetch(
      { bbox: { west: -0.5, south: 51.3, east: 0.3, north: 51.7 } },
      testContext(),
    );
    if (!all.ok || !london.ok) throw new Error("registry should parse");
    expect(london.features.length).toBeLessThan(all.features.length);
    expect(london.features.length).toBeGreaterThan(0);
  });

  it("reports healthy without making a network call", async () => {
    const health = await trafficCameras.healthcheck(testContext());
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("cameras");
  });
});
