import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SourceFeature } from "@/lib/sources/types";
import { MAP_LAYERS, defaultVisibleLayerIds, findLayer, resolveMedia } from "./index";
import type { DeckKit, LayerMedia, MapLayerDefinition, Rgba } from "./types";

/** Adding a source must never require editing the map component; these tests enforce that. */

const MAP_DIR = join(process.cwd(), "components", "map");

function componentFiles(): string[] {
  return readdirSync(MAP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => join(MAP_DIR, entry.name));
}

describe("the layer registry", () => {
  it("has unique layer ids", () => {
    const ids = MAP_LAYERS.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every layer a default sort naming one of its own columns", () => {
    for (const layer of MAP_LAYERS) {
      const keys = layer.columns.map((column) => column.key);
      expect(keys, `${layer.id} default sort`).toContain(layer.defaultSort.key);
    }
  });

  it("gives every layer exactly one row-header column", () => {
    for (const layer of MAP_LAYERS) {
      const headers = layer.columns.filter((column) => column.rowHeader);
      // Exactly one `<th scope="row">` per row so screen readers can name it.
      expect(headers.length, `${layer.id} row header columns`).toBe(1);
    }
  });

  it("gives every layer a colour in both themes", () => {
    for (const layer of MAP_LAYERS) {
      for (const channel of [...layer.colour.dark, ...layer.colour.light]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
      expect(layer.colour.token, `${layer.id} colour provenance`).not.toBe("");
    }
  });

  it("gives every layer its own empty and unavailable copy", () => {
    for (const layer of MAP_LAYERS) {
      expect(layer.emptyMessage.length, `${layer.id} empty copy`).toBeGreaterThan(20);
      expect(layer.unavailableTitle.length, `${layer.id} unavailable title`).toBeGreaterThan(4);
      // "No results" is a filter's answer, not a live source's.
      expect(layer.emptyMessage.toLowerCase()).not.toContain("no results");
    }
  });

  it("resolves a known id and returns null for an unknown one", () => {
    const first = MAP_LAYERS[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(findLayer(first.id)?.id).toBe(first.id);
    // Null, not a throw: a stale bookmark must not render an error page.
    expect(findLayer("not-a-layer")).toBeNull();
  });

  it("starts with at least one layer visible", () => {
    expect(defaultVisibleLayerIds().length).toBeGreaterThan(0);
  });
});

/**
 * Deck factories run in Node with a recorder in place of deck.gl, so the accessors that
 * back each legend can be tested without WebGL.
 */
interface RecordedDeckLayer {
  readonly props: Record<string, unknown>;
}

function captureDeck(
  layer: MapLayerDefinition,
  features: readonly SourceFeature[],
  options: { selectedId?: string | null; reducedMotion?: boolean } = {},
): RecordedDeckLayer[] {
  const recorded: RecordedDeckLayer[] = [];
  class Recorder {
    constructor(props: Record<string, unknown>) {
      recorded.push({ props });
    }
  }
  // A cast recorder instead of importing deck.gl, which would pull the renderer into this
  // test's module graph. Factories only call `new kit.X(props)`.
  const kit = {
    ScatterplotLayer: Recorder,
    IconLayer: Recorder,
    PathLayer: Recorder,
  } as unknown as DeckKit;

  layer.deck(kit, {
    id: `test-${layer.id}`,
    features,
    selectedId: options.selectedId ?? null,
    colour: [10, 20, 30, 255],
    selectedColour: [200, 210, 220, 255],
    reducedMotion: options.reducedMotion ?? false,
    onSelect: () => {},
  });
  return recorded;
}

/** One accessor out of a recorded layer's props, narrowed without `any`. */
function accessor(recorded: RecordedDeckLayer, key: string): (f: SourceFeature) => Rgba | number {
  const value = recorded.props[key];
  if (typeof value !== "function") throw new Error(`${key} is not an accessor`);
  return value as (f: SourceFeature) => Rgba | number;
}

const SAMPLE: SourceFeature = {
  id: "sample",
  kind: "aircraft",
  longitude: 0,
  latitude: 0,
  label: "sample",
  properties: {},
};

describe("every layer's deck.gl factory", () => {
  it("builds without a WebGL context and uses the id it was handed", () => {
    for (const layer of MAP_LAYERS) {
      const recorded = captureDeck(layer, [SAMPLE]);
      expect(recorded.length, `${layer.id} produced no deck layer`).toBeGreaterThan(0);
      for (const entry of recorded) {
        // Prefixed and unique across layers; a layer that invents its own id can collide.
        expect(entry.props.id).toBe(`test-${layer.id}`);
        expect(entry.props.pickable, `${layer.id} is not pickable`).toBe(true);
      }
    }
  });

  it("declares no transitions when the reader has asked for reduced motion", () => {
    // deck.gl `transitions` animate; forbid them for every layer (reduced motion).
    for (const layer of MAP_LAYERS) {
      for (const entry of captureDeck(layer, [SAMPLE], { reducedMotion: true })) {
        expect(entry.props.transitions ?? {}, `${layer.id} animates under reduced motion`).toEqual(
          {},
        );
      }
    }
  });

  it("lists the selection in the update triggers of every accessor that reads it", () => {
    // deck.gl caches accessor output; without these triggers the selection ring stays on the
    // previously selected feature.
    for (const layer of MAP_LAYERS) {
      for (const entry of captureDeck(layer, [SAMPLE], { selectedId: "sample" })) {
        const triggers = entry.props.updateTriggers;
        if (typeof entry.props.getLineColor !== "function") continue;
        expect(triggers, `${layer.id} has no updateTriggers`).toBeTruthy();
        const table = triggers as Record<string, unknown>;
        expect(Array.isArray(table.getLineColor), `${layer.id} getLineColor trigger`).toBe(true);
        expect(table.getLineColor as unknown[], `${layer.id}`).toContain("sample");
      }
    }
  });
});

describe("the symbols the legends promise", () => {
  const aircraft = findLayer("aircraft");
  const radio = findLayer("radio");

  it("draws an aircraft on the ground hollow and one in the air filled", () => {
    expect(aircraft).toBeTruthy();
    if (!aircraft) return;
    const recorded = captureDeck(aircraft, [SAMPLE])[0];
    if (!recorded) return;
    const fill = accessor(recorded, "getFillColor");
    const grounded = { ...SAMPLE, properties: { onGround: true, altitudeFt: null } };
    const airborne = { ...SAMPLE, properties: { onGround: false, altitudeFt: 37_000 } };
    expect(fill(grounded)).toEqual([0, 0, 0, 0]);
    expect(fill(airborne)).toEqual([10, 20, 30, 255]);
  });

  it("draws a plain-http radio stream hollow, because a browser will not play it", () => {
    expect(radio).toBeTruthy();
    if (!radio) return;
    const recorded = captureDeck(radio, [SAMPLE])[0];
    if (!recorded) return;
    const fill = accessor(recorded, "getFillColor");
    expect(fill({ ...SAMPLE, properties: { isInsecureStream: true } })).toEqual([0, 0, 0, 0]);
    expect(fill({ ...SAMPLE, properties: { isInsecureStream: false } })).toEqual([10, 20, 30, 255]);
  });
});

/**
 * `resolveMedia` guards community-edited URLs (e.g. Radio Browser streams) before they
 * become an `href`: no `javascript:` URLs, and the disclosed host must match the URL.
 */
function fakeLayer(media: LayerMedia | null): MapLayerDefinition {
  const base = MAP_LAYERS[0];
  if (!base) throw new Error("the registry is empty");
  return { ...base, media: () => media };
}

const MEDIA: LayerMedia = {
  kind: "image",
  url: "https://cameras.example.org/one.jpg",
  host: "cameras.example.org",
  disclosure: "Loading connects you to cameras.example.org, which will see your IP address.",
  credit: "Example credit",
};

describe("resolveMedia", () => {
  it("passes a well-formed record through", () => {
    expect(resolveMedia(fakeLayer(MEDIA), SAMPLE)?.url).toBe(MEDIA.url);
  });

  it("refuses a record whose host is not the host of its own URL", () => {
    // The disclosed `host` must be the host the browser will actually contact.
    const lying = { ...MEDIA, host: "trustworthy.example.org" };
    expect(resolveMedia(fakeLayer(lying), SAMPLE)).toBeNull();
  });

  it("refuses anything that is not http(s), whatever the kind", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const host = "cameras.example.org";
      expect(resolveMedia(fakeLayer({ ...MEDIA, kind: "link", url, host }), SAMPLE)).toBeNull();
    }
  });

  it("refuses a plain-http image or audio, and allows a plain-http link", () => {
    const http = { url: "http://stream.example.org/live", host: "stream.example.org" };
    // Would be blocked as mixed content, so it's offered as a `link` instead.
    expect(resolveMedia(fakeLayer({ ...MEDIA, kind: "image", ...http }), SAMPLE)).toBeNull();
    expect(resolveMedia(fakeLayer({ ...MEDIA, kind: "audio", ...http }), SAMPLE)).toBeNull();
    // A top-level navigation the browser will honour, so this one is offered.
    expect(resolveMedia(fakeLayer({ ...MEDIA, kind: "link", ...http }), SAMPLE)?.kind).toBe("link");
  });

  it("refuses a record with no disclosure, and a layer that offers no media", () => {
    expect(resolveMedia(fakeLayer({ ...MEDIA, disclosure: "  " }), SAMPLE)).toBeNull();
    expect(resolveMedia(fakeLayer(null), SAMPLE)).toBeNull();
  });

  it("returns null for every layer that declares no media at all", () => {
    for (const layer of MAP_LAYERS.filter((l) => l.media === undefined)) {
      expect(resolveMedia(layer, SAMPLE), `${layer.id}`).toBeNull();
    }
  });
});

describe("cadence", () => {
  it("is a declared property, never a guess about which layer this is", () => {
    for (const layer of MAP_LAYERS) {
      expect(["live", "registry", undefined]).toContain(layer.cadence);
    }
  });

  it("marks the layers that are checked rather than polled", () => {
    // A hand-verified list reports the day it was checked. Everything else reports an age.
    const registries = MAP_LAYERS.filter((l) => l.cadence === "registry").map((l) => l.id);
    expect(registries).toContain("cameras");
  });
});

describe("the map components know about no layer in particular", () => {
  // If this fails, add a field to `MapLayerDefinition` instead of branching on a layer id.
  it("mentions no layer id outside components/map/registry/", () => {
    const ids = MAP_LAYERS.map((layer) => layer.id);
    for (const file of componentFiles()) {
      const source = readFileSync(file, "utf8");
      for (const id of ids) {
        expect(source, `${file} names the layer id "${id}"`).not.toContain(`"${id}"`);
      }
    }
  });

  // Registry entries may import deck.gl types only, so the table/legend work without WebGL.
  it("imports deck.gl only as types, never as values", () => {
    const dir = join(MAP_DIR, "registry");
    for (const entry of readdirSync(dir)) {
      if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
      const source = readFileSync(join(dir, entry), "utf8");
      for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("import ")) continue;
        if (!/@deck\.gl|maplibre-gl/.test(trimmed)) continue;
        expect(trimmed, `${entry}: ${trimmed}`).toMatch(/^import type /);
      }
    }
  });
});
