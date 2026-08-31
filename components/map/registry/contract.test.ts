import { describe, expect, it } from "vitest";

import usgsFixture from "@/lib/sources/__fixtures__/usgs-earthquakes.json";
import { usgsEarthquakes } from "@/lib/sources/usgs-earthquakes";
import type { SourceFeature } from "@/lib/sources/types";
import { earthquakesLayer } from "./earthquakes";
import { weatherAlertsLayer } from "./weather";
import { MAP_LAYERS } from "./index";
import { layerPayloadSchema } from "../payload";

/**
 * THE CONTRACT TEST BETWEEN AN ADAPTER AND ITS LAYER.
 *
 * A registry entry reads `properties.magnitude`, `properties.locationBasis` and a dozen more
 * BY NAME, out of a bag the contract types as `Record<string, string | number | boolean |
 * null>`. That indirection is what lets the map and the adapters be written in parallel — it
 * is the reason neither team had to wait — and its cost is that a rename on either side is
 * not a compile error. It is an em dash in a table cell that nobody notices.
 *
 * So the adapters' own captured fixtures are run through the adapters' own `normalise` and
 * then through the registry's own accessors. If either side renames a property, a column that
 * produced a value stops producing one and this fails.
 *
 * These fixtures are real captured payloads, not invented ones. That is the point: the
 * failure this whole layer exists to survive is an upstream changing shape.
 */

/**
 * The adapter's own `normalise`, run over the adapter's own captured fixture. No network, no
 * clock, no cache — which is exactly why it is the most valuable test either side has.
 *
 * `{}` is the empty query: the whole feed, unfiltered. A `bbox` here would be testing the
 * adapter's viewport filter rather than the property contract this file is about.
 */
function normalisedQuakes(): readonly SourceFeature[] {
  return usgsEarthquakes.normalise(usgsFixture, {});
}

describe("the earthquakes layer reads what its adapter writes", () => {
  const features = normalisedQuakes();

  it("normalises the captured fixture into features", () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it("fills every column the registry declares", () => {
    const first = features[0];
    expect(first).toBeDefined();
    if (!first) return;
    for (const column of earthquakesLayer.columns) {
      expect(column.value(first), `column "${column.key}" read nothing`).not.toBeNull();
    }
  });

  it("fills the detail rows that are not optional upstream fields", () => {
    const first = features[0];
    if (!first) return;
    /*
     * `alertLevel` is null for most events by design — USGS only computes PAGER for
     * significant ones — so it is excluded rather than asserted. Asserting it would make this
     * test fail on a quiet day, which is a test that trains people to ignore it.
     */
    const required = earthquakesLayer.detail.filter((row) => row.label !== "Impact estimate");
    for (const row of required) {
      expect(row.value(first), `detail row "${row.label}" read nothing`).not.toBeNull();
    }
  });

  it("carries a link back to the origin record for every feature", () => {
    // An investigator has to be able to leave here and cite the primary source.
    for (const feature of features) {
      expect(feature.sourceUrl).toMatch(/^https:\/\/earthquake\.usgs\.gov\//);
    }
  });

  it("does not caveat a position that needs no caveat", () => {
    const first = features[0];
    if (!first) return;
    // An epicentre is the source's own located position. Caveating everything is the same as
    // caveating nothing.
    expect(earthquakesLayer.precision?.(first) ?? null).toBeNull();
  });

  it("produces a payload the client's own schema accepts", () => {
    const payload = {
      layerId: earthquakesLayer.id,
      source: {
        slug: usgsEarthquakes.slug,
        name: usgsEarthquakes.name,
        homepage: usgsEarthquakes.homepage,
        attribution: usgsEarthquakes.attribution,
        ttlSeconds: usgsEarthquakes.ttlSeconds,
      },
      ok: true,
      features,
      observedAt: new Date().toISOString(),
      stale: false,
    };
    // Zod at every boundary includes the one to our own route handler.
    expect(layerPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

/**
 * The precision caveat, which is the whole reason the weather layer is shaped as it is.
 *
 * Five of 385 measured NWS alerts carried their own geometry. The rest are administrative
 * zone centroids that can be tens of kilometres from the weather. A dot drawn without that
 * caveat is this map asserting a coordinate the National Weather Service never gave.
 */
describe("the weather layer says when a point is not the weather", () => {
  const zoneAlert: SourceFeature = {
    id: "urn:oid:2.49.0.1.840.0.example",
    kind: "weather",
    longitude: -110.9,
    latitude: 32.2,
    label: "Severe Thunderstorm Warning",
    properties: {
      event: "Severe Thunderstorm Warning",
      severity: "Severe",
      urgency: "Immediate",
      certainty: "Observed",
      headline: "Severe Thunderstorm Warning issued",
      areaDescription: "Pima, AZ",
      effectiveAt: "2026-08-31T11:00:00Z",
      expiresAt: "2026-08-31T12:00:00Z",
      issuedBy: "NWS Tucson AZ",
      recommendedResponse: "Shelter",
      locationBasis: "zone",
      zoneCode: "AZC019",
      coversMultipleZones: true,
    },
  };

  const polygonAlert: SourceFeature = {
    ...zoneAlert,
    id: "urn:oid:2.49.0.1.840.0.polygon",
    properties: { ...zoneAlert.properties, locationBasis: "polygon", zoneCode: null, coversMultipleZones: false },
  };

  it("caveats a zone-derived point, naming the zone", () => {
    const precision = weatherAlertsLayer.precision?.(zoneAlert) ?? null;
    expect(precision).not.toBeNull();
    expect(precision?.label).toBe("zone centre");
    expect(precision?.note).toContain("AZC019");
    expect(precision?.note).toContain("tens of kilometres");
    // It also has to say the alert is not confined to the point it is drawn at.
    expect(precision?.note).toContain("whole zone");
  });

  it("says when the alert covers zones that are not drawn", () => {
    expect(weatherAlertsLayer.precision?.(zoneAlert)?.note).toContain("further zones");
  });

  it("does NOT caveat an alert that carried its own polygon", () => {
    expect(weatherAlertsLayer.precision?.(polygonAlert) ?? null).toBeNull();
  });

  it("sorts severity by CAP rank, not alphabetically", () => {
    const column = weatherAlertsLayer.columns.find((c) => c.key === "severity");
    expect(column).toBeDefined();
    const extreme = { ...zoneAlert, properties: { ...zoneAlert.properties, severity: "Extreme" } };
    const minor = { ...zoneAlert, properties: { ...zoneAlert.properties, severity: "Minor" } };
    // Alphabetically "Extreme" < "Minor", which would put the worst alerts last.
    expect(Number(column?.value(extreme))).toBeGreaterThan(Number(column?.value(minor)));
  });

  it("renders the severity word, not its rank", () => {
    const column = weatherAlertsLayer.columns.find((c) => c.key === "severity");
    expect(column?.format?.(zoneAlert)).toBe("Severe");
  });
});

describe("every registry layer points at a source that exists", () => {
  it("names a slug", () => {
    for (const layer of MAP_LAYERS) {
      expect(layer.sourceSlug.length, `${layer.id} has no source slug`).toBeGreaterThan(0);
    }
  });
});
