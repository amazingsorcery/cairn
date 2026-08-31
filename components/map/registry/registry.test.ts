import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAP_LAYERS, defaultVisibleLayerIds, findLayer } from "./index";

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
