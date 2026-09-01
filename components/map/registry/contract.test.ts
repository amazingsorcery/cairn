import { describe, expect, it } from "vitest";

import adsbFixture from "@/lib/sources/__fixtures__/adsb-lol.json";
import radioFixture from "@/lib/sources/__fixtures__/radio-browser.json";
import usgsFixture from "@/lib/sources/__fixtures__/usgs-earthquakes.json";
import fintrafficRegistry from "@/content/cameras/fintraffic-digitraffic.json";
import tflRegistry from "@/content/cameras/transport-for-london.json";
import { adsbLol } from "@/lib/sources/adsb-lol";
import { csvToRecords, normaliseFirms } from "@/lib/sources/nasa-firms";
import { radioBrowser } from "@/lib/sources/radio-browser";
import { normaliseCameras } from "@/lib/sources/traffic-cameras";
import { usgsEarthquakes } from "@/lib/sources/usgs-earthquakes";
import type { SourceFeature } from "@/lib/sources/types";
import { aircraftLayer } from "./aircraft";
import { camerasLayer } from "./cameras";
import { earthquakesLayer } from "./earthquakes";
import { radioLayer } from "./radio";
import { weatherAlertsLayer } from "./weather";
import { wildfiresLayer } from "./wildfires";
import { MAP_LAYERS, featurePrecision } from "./index";
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

/**
 * AIRCRAFT — the viewport-scoped layer, and the one whose adapter emits two different
 * absences that must not render as the same thing.
 *
 * The fixture is a real captured adsb.lol response: 165 aircraft, 41 of them on the ground
 * (25%, exactly as the brief warned) and 4 broadcasting no callsign at all.
 */
describe("the aircraft layer reads what its adapter writes", () => {
  const features = adsbLol.normalise(adsbFixture, {});

  it("normalises the captured fixture into features", () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it("names every feature, including the ones broadcasting no callsign", () => {
    const rowHeader = aircraftLayer.columns.find((column) => column.rowHeader);
    expect(rowHeader).toBeDefined();
    const unnamed = features.filter((feature) => feature.properties.callsign === null);
    // The fixture has to contain some, or this test is asserting nothing.
    expect(unnamed.length).toBeGreaterThan(0);
    for (const feature of features) {
      const value = rowHeader?.value(feature);
      expect(value, `${feature.id} has no row header`).not.toBeNull();
      expect(String(value).trim().length).toBeGreaterThan(0);
    }
  });

  it("says 'on ground' for a grounded aircraft and sorts it at zero, not as an absence", () => {
    const column = aircraftLayer.columns.find((c) => c.key === "altitudeFt");
    const grounded = features.filter((feature) => feature.properties.onGround === true);
    expect(grounded.length).toBeGreaterThan(0);
    for (const feature of grounded) {
      expect(column?.format?.(feature)).toBe("on ground");
      // Zero, not null: the source said where it is. Null is kept for an unreported altitude,
      // and `sort.ts` floats nulls last in both directions.
      expect(column?.value(feature)).toBe(0);
    }
  });

  it("fills altitude, and only altitude, differently for airborne aircraft", () => {
    const column = aircraftLayer.columns.find((c) => c.key === "altitudeFt");
    const airborne = features.filter((feature) => typeof feature.properties.altitudeFt === "number");
    expect(airborne.length).toBeGreaterThan(0);
    const first = airborne[0];
    if (!first) return;
    expect(column?.format?.(first)).toMatch(/ ft$/);
    expect(typeof column?.value(first)).toBe("number");
  });

  it("carries a link back to the origin record for every aircraft", () => {
    for (const feature of features) {
      expect(feature.sourceUrl).toMatch(/^https:\/\/globe\.adsb\.lol\//);
    }
  });

  it("asks for no viewport when the reader has not chosen one", () => {
    /*
     * The map's opening view — and what the server renders for — is the whole world. A 250 nm
     * endpoint cannot answer that, and turning it into a bbox would poll the middle of the
     * Atlantic. `{}` is the adapter's documented "use the configured area".
     */
    expect(aircraftLayer.query?.({ west: -180, south: -85, east: 180, north: 85 })).toEqual({});
  });

  it("asks for the viewport once the reader has chosen an area", () => {
    const bounds = { west: -1, south: 51, east: 1, north: 52 };
    expect(aircraftLayer.query?.(bounds)).toEqual({ bbox: bounds });
  });

  it("caveats a stale position and leaves a fresh one alone", () => {
    const first = features[0];
    if (!first) return;
    const fresh: SourceFeature = {
      ...first,
      properties: { ...first.properties, positionAgeSeconds: 2, groundSpeedKt: 450 },
    };
    const stale: SourceFeature = {
      ...first,
      properties: { ...first.properties, positionAgeSeconds: 120, groundSpeedKt: 450 },
    };
    // Two seconds old is as exact as ADS-B gets. Caveating that would be caveating nothing.
    expect(featurePrecision(aircraftLayer, fresh)).toBeNull();
    const precision = featurePrecision(aircraftLayer, stale);
    expect(precision?.label).toContain("120");
    expect(precision?.note).toContain("450");
    // 450 kt for 120 s is about 27.8 km. The radius is stated in metres.
    expect(precision?.approximateRadiusMetres ?? 0).toBeGreaterThan(20_000);
  });

  it("says the position is a guess, not how far, when no speed was reported", () => {
    const first = features[0];
    if (!first) return;
    const noSpeed: SourceFeature = {
      ...first,
      properties: { ...first.properties, positionAgeSeconds: 90, groundSpeedKt: null },
    };
    const precision = featurePrecision(aircraftLayer, noSpeed);
    expect(precision?.note).toContain("no way to say how far");
    // No invented radius when there is no speed to derive one from.
    expect(precision?.approximateRadiusMetres).toBeUndefined();
  });
});

/**
 * RADIO — a point registry whose every coordinate needs the same caveat, and where one
 * station in five cannot play on a secure page.
 */
describe("the radio layer reads what its adapter writes", () => {
  const features = radioBrowser.normalise(radioFixture, {});

  it("normalises the captured fixture into features", () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it("fills every column it declares, or renders an honest absence", () => {
    const first = features[0];
    if (!first) return;
    for (const column of ["station", "country", "stream"]) {
      const declared = radioLayer.columns.find((c) => c.key === column);
      expect(declared?.value(first), `column "${column}" read nothing`).not.toBeNull();
    }
  });

  it("names every station, including the ones the catalogue left unnamed", () => {
    const rowHeader = radioLayer.columns.find((column) => column.rowHeader);
    for (const feature of features) {
      expect(String(rowHeader?.value(feature) ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("marks the plain-http streams rather than hiding them", () => {
    const column = radioLayer.columns.find((c) => c.key === "stream");
    const insecure = features.filter((f) => f.properties.isInsecureStream === true);
    // A fifth of the catalogue is http-only. If the fixture has none, this asserts nothing.
    expect(insecure.length).toBeGreaterThan(0);
    for (const feature of insecure) {
      expect(column?.value(feature)).toBe("plain http");
    }
    const secure = features.filter((f) => f.properties.isInsecureStream === false);
    for (const feature of secure) expect(column?.value(feature)).toBe("https");
  });

  it("renders no bitrate rather than '0 kbps' when the catalogue has none", () => {
    const column = radioLayer.columns.find((c) => c.key === "bitrateKbps");
    const unrecorded = features.filter((f) => f.properties.bitrateKbps === 0);
    for (const feature of unrecorded) {
      expect(column?.value(feature)).toBeNull();
      expect(column?.format?.(feature)).toBeNull();
    }
  });

  it("caveats every station's position, because none of them is a transmitter", () => {
    for (const feature of features) {
      const precision = featurePrecision(radioLayer, feature);
      expect(precision, `${feature.id} was drawn without a caveat`).not.toBeNull();
      expect(precision?.note).toContain("not a transmitter site");
    }
  });
});

/**
 * CAMERAS — the registry content IS the fixture. It is committed, hand-verified content
 * rather than a captured upstream payload, which is exactly what makes it the right thing to
 * assert against: if somebody edits `content/cameras/*.json` and renames a field, this fails.
 */
describe("the cameras layer reads what its adapter writes", () => {
  const features = normaliseCameras([tflRegistry, fintrafficRegistry], {});

  it("normalises the committed registry into features", () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it("fills every column it declares, for every camera", () => {
    for (const feature of features) {
      for (const column of camerasLayer.columns) {
        expect(column.value(feature), `${feature.id}: column "${column.key}"`).not.toBeNull();
      }
    }
  });

  it("carries the credit the licence makes mandatory, per camera", () => {
    const row = camerasLayer.detail.find((r) => r.label === "Required credit");
    for (const feature of features) {
      const credit = row?.value(feature);
      expect(credit, `${feature.id} has no credit`).not.toBeNull();
      // Both providers make it a condition of use, so the row has to say so.
      expect(credit).toContain("required by the licence");
    }
  });

  it("discloses the direct connection, naming the host, before the reader makes it", () => {
    const row = camerasLayer.detail.find((r) => r.label === "Connecting to this camera");
    for (const feature of features) {
      const disclosure = row?.value(feature) ?? "";
      const host = new URL(String(feature.properties.embedUrl)).host;
      expect(disclosure, `${feature.id}`).toContain(host);
      expect(disclosure).toContain("IP address");
    }
  });

  it("does NOT caveat a position the operator itself published", () => {
    /*
     * Camera coordinates are often geocoded from a road name, and if these were they would
     * need the weather layer's caveat. Each entry's `confidenceNotes` records them as read
     * from TfL's and Digitraffic's own APIs, so caveating them would be caveating everything.
     */
    for (const feature of features) {
      expect(featurePrecision(camerasLayer, feature)).toBeNull();
    }
  });
});

/**
 * WILDFIRES — and the one honest thing to say about this suite.
 *
 * ⚠ **There is no captured FIRMS payload, so nothing below proves NASA's column names.** A
 * MAP_KEY requires registering an account and none was available; a keyless request returns
 * `HTTP 400 / Invalid MAP_KEY.` and nothing else. `lib/sources/nasa-firms.test.ts` carries the
 * same warning at the top of the file.
 *
 * What these tests DO prove is the thing this file exists for: that the property names the
 * layer reads are the property names the adapter writes. The CSV below is written from NASA's
 * documented columns — the same source the parser was written from — so if either side
 * renames a field, this fails. When somebody captures a real response to
 * `lib/sources/__fixtures__/nasa-firms.csv`, this suite should be pointed at it and this
 * comment deleted.
 */
const DOCUMENTED_FIRMS_CSV = [
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  "-11.16899,17.14515,331.5,0.42,0.38,2026-08-31,1219,N,VIIRS,n,2.0NRT,289.5,3.7,D",
  "37.44252,-120.32,367.2,0.51,0.47,2026-08-31,0942,N,VIIRS,h,2.0NRT,301.1,54.9,N",
].join("\n");

describe("the wildfires layer reads what its adapter writes", () => {
  const features = normaliseFirms(csvToRecords(DOCUMENTED_FIRMS_CSV), {});

  it("maps the documented columns into features", () => {
    expect(features).toHaveLength(2);
  });

  it("fills every column it declares", () => {
    for (const feature of features) {
      for (const column of wildfiresLayer.columns) {
        expect(column.value(feature), `${feature.id}: column "${column.key}"`).not.toBeNull();
      }
    }
  });

  it("fills every detail row it declares", () => {
    const first = features[0];
    if (!first) return;
    for (const row of wildfiresLayer.detail) {
      expect(row.value(first), `detail row "${row.label}" read nothing`).not.toBeNull();
    }
  });

  it("keeps the source's own confidence scale rather than translating it", () => {
    const column = wildfiresLayer.columns.find((c) => c.key === "confidence");
    const first = features[0];
    if (!first) return;
    // The raw letter is what sorts; the cell says which scale it is on and nothing more.
    expect(column?.value(first)).toBe("n");
    expect(column?.format?.(first)).toBe("n (VIIRS letter scale, unaltered)");
  });

  it("says a detection is a pixel, on every feature, with the instrument's own footprint", () => {
    for (const feature of features) {
      const precision = featurePrecision(wildfiresLayer, feature);
      expect(precision?.label).toBe("satellite pixel");
      expect(precision?.note).toContain("375 m across");
      expect(precision?.note).toContain("not the position of a fire");
      // Half a 375 m pixel. Stated only because the instrument was reported.
      expect(precision?.approximateRadiusMetres).toBe(188);
    }
  });

  it("caveats without a footprint rather than guessing one for an unknown instrument", () => {
    const first = features[0];
    if (!first) return;
    const unknown: SourceFeature = {
      ...first,
      properties: { ...first.properties, instrument: null },
    };
    const precision = featurePrecision(wildfiresLayer, unknown);
    expect(precision?.note).toContain("not stated here");
    expect(precision?.approximateRadiusMetres).toBeUndefined();
  });
});

describe("every registry layer points at a source that exists", () => {
  it("names a slug", () => {
    for (const layer of MAP_LAYERS) {
      expect(layer.sourceSlug.length, `${layer.id} has no source slug`).toBeGreaterThan(0);
    }
  });
});
