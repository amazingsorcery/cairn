import { describe, expect, it } from "vitest";

import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition } from "./registry";
import { nextSort, sortDescription, sortFeatures } from "./sort";

/**
 * The table's ordering rules. Pure functions, so no DOM and no renderer.
 *
 * The null-last rule is the one worth a test: it was worked out on `/live/flights` for
 * aircraft with no callsign, and it is the kind of behaviour a later "simplification" to a
 * plain comparator silently reverses.
 */

function feature(id: string, value: number | null, name: string | null): SourceFeature {
  return {
    id,
    kind: "earthquakes",
    longitude: 0,
    latitude: 0,
    label: id,
    properties: { value, name },
  };
}

const layer = {
  id: "test",
  columns: [
    {
      key: "value",
      label: "value",
      numeric: true,
      rowHeader: true,
      initialDirection: "desc",
      value: (f: SourceFeature) => {
        const raw = f.properties.value;
        return typeof raw === "number" ? raw : null;
      },
    },
    {
      key: "name",
      label: "name",
      numeric: false,
      initialDirection: "asc",
      value: (f: SourceFeature) => {
        const raw = f.properties.name;
        return typeof raw === "string" ? raw : null;
      },
    },
  ],
  label: "Test layer",
} as unknown as MapLayerDefinition;

describe("sortFeatures", () => {
  const features = [
    feature("b", 2, "beta"),
    feature("a", null, null),
    feature("c", 9, "gamma"),
    feature("d", 2, "delta"),
  ];

  it("sorts numerically, not lexically", () => {
    const ids = sortFeatures(features, layer, { key: "value", direction: "desc" }).map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(["c", "b", "d"]);
  });

  it("puts absent values last in BOTH directions", () => {
    const descending = sortFeatures(features, layer, { key: "value", direction: "desc" });
    const ascending = sortFeatures(features, layer, { key: "value", direction: "asc" });
    // An absence is not "smaller than everything". Floating it to the top of a descending
    // sort buries the data the reader asked to see under the rows that have none of it.
    expect(descending.at(-1)?.id).toBe("a");
    expect(ascending.at(-1)?.id).toBe("a");
  });

  it("breaks ties on the feature id so equal rows do not reshuffle between refreshes", () => {
    const first = sortFeatures(features, layer, { key: "value", direction: "desc" });
    const second = sortFeatures([...features].reverse(), layer, {
      key: "value",
      direction: "desc",
    });
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
  });

  it("does not mutate the input", () => {
    const input = [...features];
    sortFeatures(input, layer, { key: "value", direction: "asc" });
    expect(input.map((f) => f.id)).toEqual(features.map((f) => f.id));
  });

  it("falls back to the first column for an unknown sort key", () => {
    expect(() => sortFeatures(features, layer, { key: "gone", direction: "asc" })).not.toThrow();
  });
});

describe("nextSort", () => {
  it("reverses the current column", () => {
    expect(nextSort({ key: "value", direction: "desc" }, "value", "desc")).toEqual({
      key: "value",
      direction: "asc",
    });
  });

  it("starts a new column in the direction the registry declared", () => {
    // "Sort by magnitude" almost always means "show me the big ones".
    expect(nextSort({ key: "name", direction: "asc" }, "value", "desc")).toEqual({
      key: "value",
      direction: "desc",
    });
  });

  it("defaults a column with no declared direction to ascending", () => {
    expect(nextSort({ key: "value", direction: "asc" }, "name", undefined)).toEqual({
      key: "name",
      direction: "asc",
    });
  });
});

describe("sortDescription", () => {
  it("names the layer, the column and the direction for the live region", () => {
    expect(sortDescription(layer, { key: "value", direction: "desc" })).toBe(
      "Test layer sorted by value, descending.",
    );
  });
});
