import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SourceFeature } from "@/lib/sources/types";
import { MAP_LAYERS, defaultVisibleLayerIds, findLayer } from "./index";
import type { DeckKit, MapLayerDefinition, Rgba } from "./types";

/**
 * THE REGISTRY'S STRUCTURAL GUARANTEE, ENFORCED RATHER THAN ASSERTED.
 *
 * "Adding a source must never require editing the map component" is the single most
 * important structural decision in this half of the build, and it is the kind of claim that
 * is true on the day it is written and false three sources later — because the fastest way
 * to ship layer four is one `if`. These tests fail the build at that moment instead.
 */

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
      // A row with no `<th scope="row">` is a row a screen reader cannot name; two is a
      // table with two header cells per row, which is worse than none.
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
      // "No results" is a filter's answer, not a live source's. See states.md §0.
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
 * THE DECK FACTORIES, RUN WITHOUT WEBGL.
 *
 * `deck` receives its constructors (see `types.ts`), which is a bundling decision — but it
 * also means the factories can be exercised in Node with a recorder in place of deck.gl. That
 * is worth doing: the accessors are where a layer encodes what its legend promises, and
 * nothing else in this suite would notice if `getFillColor` stopped distinguishing an
 * aircraft on the ground from one at 37,000 feet.
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
  /*
   * `as unknown as DeckKit` rather than a real deck.gl import: pulling the constructors in
   * here would put the renderer into this test's module graph, which is the very coupling
   * `registry.test.ts` exists to forbid. The recorder satisfies the shape the factories use —
   * they only ever call `new kit.X(props)` — and nothing here touches a WebGL context.
   */
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
    /*
     * deck.gl `transitions` interpolate over frames, which is continuous motion by another
     * name. This is the one accessibility rule the registry can enforce for every layer at
     * once, rather than trusting each new file to remember it.
     */
    for (const layer of MAP_LAYERS) {
      for (const entry of captureDeck(layer, [SAMPLE], { reducedMotion: true })) {
        expect(entry.props.transitions ?? {}, `${layer.id} animates under reduced motion`).toEqual(
          {},
        );
      }
    }
  });

  it("lists the selection in the update triggers of every accessor that reads it", () => {
    /*
     * WITHOUT THIS THE MAP LIES. deck.gl caches accessor output per layer instance and will
     * not re-evaluate `getLineColor` because `selectedId` changed, so the selection ring stays
     * on the previously selected feature. Every layer here draws its selection through the
     * line colour and width, so both triggers must exist.
     */
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

describe("the map components know about no layer in particular", () => {
  /**
   * The regression test for rule 1. If this fails, someone has written a branch on a layer
   * id inside a component, and the fix is a field on `MapLayerDefinition` — not an exception
   * here.
   */
  it("mentions no layer id outside components/map/registry/", () => {
    const ids = MAP_LAYERS.map((layer) => layer.id);
    for (const file of componentFiles()) {
      const source = readFileSync(file, "utf8");
      for (const id of ids) {
        expect(source, `${file} names the layer id "${id}"`).not.toContain(`"${id}"`);
      }
    }
  });

  /**
   * The registry must stay loadable with no WebGL. If an entry ever imports a deck.gl value
   * rather than a type, the table, the legend and the toggles start dragging the renderer
   * into every bundle that reads a column label — and the table stops being an equivalent
   * that works without WebGL.
   */
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
