import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SourceFeature } from "@/lib/sources/types";
import { earthquakesLayer } from "./registry/earthquakes";
import { FeatureTable } from "./feature-table";
import type { TableSort } from "./registry";

/**
 * THE TABLE IS A REQUIRED EQUIVALENT (product-brief §2a), so its semantics get tests rather
 * than a comment. A blind investigator has to be able to read every feature, sort them, and
 * open one — and none of that may need WebGL.
 *
 * These render the real earthquakes layer definition rather than a fixture layer, so the test
 * also fails if the registry entry loses its row header or its formatters.
 */

function quake(
  id: string,
  magnitude: number | null,
  place: string | null,
  depthKm: number | null,
): SourceFeature {
  return {
    id,
    kind: "earthquakes",
    longitude: -104.112,
    latitude: 31.732,
    label: `M ${magnitude ?? "?"} - ${place ?? "unknown"}`,
    sourceUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`,
    properties: {
      magnitude,
      magnitudeType: "ml",
      place,
      depthKm,
      occurredAt: 1788167769172,
      reviewStatus: "reviewed",
      tsunami: false,
      significance: 168,
    },
  };
}

const FEATURES = [
  quake("one", 3.3, "48 km W of Mentone, Texas", 7.6),
  quake("two", 4.6, "28 km ESE of Kurilsk, Russia", 147.8),
  quake("three", null, null, null),
];

function renderTable(sort: TableSort = { key: "magnitude", direction: "desc" }) {
  const onSortChange = vi.fn();
  const onSelect = vi.fn();
  render(
    <FeatureTable<SourceFeature>
      layer={earthquakesLayer}
      features={FEATURES}
      sort={sort}
      onSortChange={onSortChange}
      selectedId={null}
      onSelect={onSelect}
      caption="Earthquakes: 3 features from the U.S. Geological Survey."
    />,
  );
  return { onSortChange, onSelect };
}

describe("FeatureTable", () => {
  it("is a real table with a caption and column headers", () => {
    renderTable();
    const table = screen.getByRole("table", {
      name: /Earthquakes: 3 features from the U.S. Geological Survey/,
    });
    expect(table).toBeInTheDocument();
    // Every registry column, plus the position column the table always adds.
    expect(within(table).getAllByRole("columnheader")).toHaveLength(
      earthquakesLayer.columns.length + 1,
    );
  });

  it("gives every row a row header naming it", () => {
    renderTable();
    const rowHeaders = screen.getAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(FEATURES.length);
  });

  it("reports the current sort through aria-sort rather than an icon alone", () => {
    renderTable({ key: "magnitude", direction: "desc" });
    const header = screen.getByRole("columnheader", { name: /magnitude/i });
    expect(header).toHaveAttribute("aria-sort", "descending");
    const place = screen.getByRole("columnheader", { name: /place/i });
    expect(place).toHaveAttribute("aria-sort", "none");
  });

  it("sorts from the keyboard, with no pointer", async () => {
    const user = userEvent.setup();
    const { onSortChange } = renderTable({ key: "magnitude", direction: "desc" });
    const button = within(screen.getByRole("columnheader", { name: /depth/i })).getByRole(
      "button",
    );
    button.focus();
    await user.keyboard("{Enter}");
    expect(onSortChange).toHaveBeenCalledWith({ key: "depthKm", direction: "desc" });
  });

  it("renders an absent value as an em dash with a spoken word, never a blank cell", () => {
    renderTable();
    // A blank cell is indistinguishable from a rendering failure, and on a live surface the
    // difference between "not reported" and "we lost it" is the difference that matters.
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
  });

  it("opens a feature from its row header, which is also the row's only control", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderTable();
    await user.click(screen.getByRole("button", { name: /M 4\.6/ }));
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("marks the open row with aria-pressed", () => {
    render(
      <FeatureTable<SourceFeature>
        layer={earthquakesLayer}
        features={FEATURES}
        sort={{ key: "magnitude", direction: "desc" }}
        onSortChange={vi.fn()}
        selectedId="two"
        onSelect={vi.fn()}
        caption="Earthquakes."
      />,
    );
    expect(screen.getByRole("button", { name: /M 4\.6/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
