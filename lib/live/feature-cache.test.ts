import { beforeEach, describe, expect, it } from "vitest";

import type { Attribution, SourceFeature } from "@/lib/sources/types";
import {
  clearPayloadCache,
  findCachedFeature,
  readPayload,
  writePayload,
  type CachedLayerPayload,
} from "./feature-cache";

/**
 * QV-13/QV-14. The save path resolves a live feature HERE and nowhere else, so these tests
 * are about the two properties the snapshot's honesty rests on:
 *
 *   1. a feature is found by `(sourceSlug, featureRef)` across every cached viewport, so a
 *      viewport-scoped source is savable without the client naming a cache key;
 *   2. a feature the cache no longer holds resolves to `null`, so the action fails the save
 *      rather than trusting a request body for the attribution and licence.
 */

const CREDIT: Attribution = {
  text: "USGS Earthquake Hazards Program",
  href: "https://earthquake.usgs.gov/",
  licence: "public domain (US Government)",
};

function feature(id: string, label: string): SourceFeature {
  return {
    id,
    kind: "earthquakes",
    latitude: 38.1,
    longitude: -122.4,
    label,
    properties: { magnitude: 4.6 },
  };
}

function payload(overrides: Partial<CachedLayerPayload> = {}): CachedLayerPayload {
  return {
    sourceSlug: "usgs-earthquakes",
    sourceName: "USGS Earthquake Hazards Program",
    sourceKind: "earthquakes",
    features: [feature("us7000abcd", "M 4.6 — 12 km SW of Petrolia")],
    observedAt: new Date("2026-09-01T09:00:00.000Z"),
    cachedAt: new Date("2026-09-01T09:00:02.000Z"),
    ttlSeconds: 60,
    attribution: CREDIT,
    ...overrides,
  };
}

describe("findCachedFeature", () => {
  beforeEach(() => {
    clearPayloadCache();
  });

  it("finds a feature without being told which viewport answered for it", () => {
    // The cache key is `slug:normalisedQuery` (QV-04). The save path does not know the
    // reader's viewport, and asking the client for it would put a cache key under the
    // client's control — which is the whole shape of the bug being closed here.
    writePayload("usgs-earthquakes:bbox=-10,40,10,60", payload());

    const found = findCachedFeature("usgs-earthquakes", "us7000abcd");

    expect(found).not.toBeNull();
    expect(found?.sourceName).toBe("USGS Earthquake Hazards Program");
    expect(found?.attribution.licence).toBe("public domain (US Government)");
    expect(found?.observedAt.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("returns null when the cache no longer holds it, so the save can fail closed", () => {
    writePayload("usgs-earthquakes:unscoped", payload());

    expect(findCachedFeature("usgs-earthquakes", "us7000zzzz")).toBeNull();
    expect(findCachedFeature("adsb-lol", "us7000abcd")).toBeNull();

    clearPayloadCache();
    expect(findCachedFeature("usgs-earthquakes", "us7000abcd")).toBeNull();
  });

  it("prefers the most recently observed payload when two viewports overlap", () => {
    // Two overlapping bounding boxes both contain the same aircraft, a minute apart. The
    // later observation is the more truthful record of where the thing is.
    writePayload(
      "adsb-lol:bbox=-5,50,5,55",
      payload({
        sourceSlug: "adsb-lol",
        sourceName: "adsb.lol",
        sourceKind: "aircraft",
        observedAt: new Date("2026-09-01T09:00:00.000Z"),
        features: [feature("4ca7b5", "BAW117")],
      }),
    );
    writePayload(
      "adsb-lol:bbox=0,50,10,55",
      payload({
        sourceSlug: "adsb-lol",
        sourceName: "adsb.lol",
        sourceKind: "aircraft",
        observedAt: new Date("2026-09-01T09:01:00.000Z"),
        features: [feature("4ca7b5", "BAW117 later")],
      }),
    );

    const found = findCachedFeature("adsb-lol", "4ca7b5");
    expect(found?.observedAt.toISOString()).toBe("2026-09-01T09:01:00.000Z");
    expect(found?.feature.label).toBe("BAW117 later");
  });

  it("does not grow without bound", () => {
    // A crafted stream of viewport parameters must not be able to fill a small VPS.
    for (let index = 0; index < 300; index += 1) {
      writePayload(`usgs-earthquakes:bbox=${index}`, payload({ features: [] }));
    }
    expect(readPayload("usgs-earthquakes:bbox=0")).toBeUndefined();
    expect(readPayload("usgs-earthquakes:bbox=299")).toBeDefined();
  });
});
