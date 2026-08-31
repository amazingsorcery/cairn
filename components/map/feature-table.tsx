"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, TableColumn, TableSort } from "./registry";
import { ARIA_SORT, nextSort, sortFeatures } from "./sort";

/**
 * THE TABLE IS A REQUIRED EQUIVALENT, NOT A FALLBACK. product-brief §2a, ADR 0019.
 *
 * A blind investigator has to be able to do the work here, and "the work" is not "know that
 * a map exists". It is: read every feature, sort them, compare them, open one, and follow it
 * back to its origin. All five are in this table.
 *
 * ## What that costs, and why it is paid here rather than promised
 *
 * 1. **It renders with no WebGL, ever.** This component imports nothing from deck.gl or
 *    MapLibre — not even a type that would drag a runtime import in. It reads the registry,
 *    which is deliberately free of both (`registry/types.ts`). A reader who never loads the
 *    map, or whose browser refuses WebGL, loses nothing but the picture.
 * 2. **It is in the server-rendered HTML.** The route fetches the layers and passes them in,
 *    so the table is complete before any JavaScript runs. What JavaScript adds is sorting and
 *    the detail panel; what it never adds is a row.
 * 3. **It is a real `<table>`.** A `<caption>`, `scope="col"` on every column header, and
 *    `scope="row"` on one cell per row so a screen reader can name the row it is inside.
 *    Sorting is a `<button>` inside the `<th>`, so it is reachable and operable from the
 *    keyboard, and the `<th>` carries `aria-sort` so the current order is reported rather
 *    than inferred from an icon.
 *
 * ## Why it is generic over the registry
 *
 * Columns, formatting, the row header and the default order are all fields on the layer
 * record. This file knows about no layer in particular, so adding a source adds a registry
 * entry and gains a full accessible table for free. A table hand-written per source is a
 * table that gets written for the first source and skipped for the ninth.
 *
 * Sort changes are announced through the ROUTE's single polite live region, which
 * `map-surface.tsx` owns — never from here. More than one live region per route and a screen
 * reader queues announcements from regions the reader is not looking at
 * (`docs/frontend/HANDOFF-shell.md` §10.1).
 */

export interface FeatureTableProps<F extends SourceFeature = SourceFeature> {
  layer: MapLayerDefinition<F>;
  features: readonly F[];
  sort: TableSort;
  onSortChange: (sort: TableSort) => void;
  selectedId: string | null;
  onSelect: (featureId: string) => void;
  /** The table's accessible name. Says what these rows are and how old they are. */
  caption: string;
}

export function FeatureTable<F extends SourceFeature>({
  layer,
  features,
  sort,
  onSortChange,
  selectedId,
  onSelect,
  caption,
}: FeatureTableProps<F>) {
  const sorted = React.useMemo(() => sortFeatures(features, layer, sort), [features, layer, sort]);

  /*
   * Exactly one column is the row header. The registry declares it; this falls back to the
   * first column rather than rendering a table whose rows have no header cell, because a row
   * with no `<th scope="row">` is a row a screen reader cannot name.
   */
  const rowHeaderColumn = layer.columns.find((c) => c.rowHeader) ?? layer.columns[0];
  if (!rowHeaderColumn) return null;
  const dataColumns = layer.columns.filter((c) => c.key !== rowHeaderColumn.key);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {[rowHeaderColumn, ...dataColumns].map((column) => (
              <SortableHeader
                key={column.key}
                column={column}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
            <th
              scope="col"
              className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground"
            >
              position
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((feature, index) => (
            <tr
              /*
               * THE INDEX IS IN THE KEY BECAUSE AN UPSTREAM BROKE THE ID PROMISE.
               *
               * `SourceFeature.id` is contracted to be stable and unique within a source, and
               * the NWS alerts feed emits the same id for several features (one alert appears
               * once per zone it covers, keeping the alert's own identifier). React then
               * collides on the key and its own warning says the behaviour is "duplicated
               * and/or omitted" — which on this surface means a table that silently loses
               * rows it has already counted.
               *
               * Deduplicating here would be worse: it would drop real alerts and make the
               * count a lie. Appending the sorted index makes the key unique without touching
               * the data, and it is stable because the sort is stable (`sort.ts` tiebreaks on
               * the id and `Array.prototype.sort` preserves input order for equal elements).
               *
               * The real fix belongs in the adapter. Reported in
               * `docs/frontend/HANDOFF-map.md` §10.
               */
              key={`${feature.id}::${index}`}
              className={cn(
                "border-b border-border last:border-0",
                selectedId === feature.id && "bg-accent",
              )}
            >
              <th scope="row" className="p-0 text-left font-normal">
                {/*
                  The row header is also the control that opens the feature. One target, not
                  two: a separate "details" button in every row would double the tab stops a
                  keyboard reader crosses to get through the table.
                */}
                <button
                  type="button"
                  onClick={() => onSelect(feature.id)}
                  aria-pressed={selectedId === feature.id}
                  className={cn(
                    "flex min-h-11 w-full items-center px-3 py-2 font-semibold",
                    "underline-offset-4 hover:underline",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    "focus-visible:ring-ring",
                    rowHeaderColumn.numeric && "justify-end tabular",
                  )}
                >
                  <Cell column={rowHeaderColumn} feature={feature} />
                  <span className="sr-only"> — show details</span>
                </button>
              </th>
              {dataColumns.map((column) => (
                <td
                  key={column.key}
                  className={cn("px-3 py-2", column.numeric && "text-right tabular")}
                >
                  <Cell column={column} feature={feature} />
                </td>
              ))}
              <td className="px-3 py-2 text-right font-mono tabular">
                {feature.latitude.toFixed(4)}, {feature.longitude.toFixed(4)}
                {/*
                  THE PRECISION CAVEAT TRAVELS WITH THE NUMBER IT QUALIFIES. A note that a
                  coordinate is an administrative centroid rather than the thing's position
                  belongs in the cell holding that coordinate — not in a page-level footnote,
                  which a reader scanning a table will never read twice. `layer.precision` is
                  a registry field, so this cell knows nothing about which layer it is in.
                */}
                <Precision layer={layer} feature={feature} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortableHeader<F extends SourceFeature>({
  column,
  sort,
  onSortChange,
}: {
  column: TableColumn<F>;
  sort: TableSort;
  onSortChange: (sort: TableSort) => void;
}) {
  const active = sort.key === column.key;
  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <th
      scope="col"
      aria-sort={active ? ARIA_SORT[sort.direction] : "none"}
      className={cn("p-0 font-medium", column.numeric ? "text-right" : "text-left")}
    >
      <button
        type="button"
        onClick={() => onSortChange(nextSort(sort, column.key, column.initialDirection))}
        className={cn(
          "flex min-h-11 w-full items-center gap-1.5 px-3 py-2",
          "text-xs uppercase tracking-wide text-muted-foreground",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
          column.numeric ? "justify-end" : "justify-start",
          active && "text-foreground",
        )}
      >
        {column.label}
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="sr-only">
          {active
            ? `, currently sorted ${ARIA_SORT[sort.direction]}. Activate to reverse.`
            : ", activate to sort by this column"}
        </span>
      </button>
    </th>
  );
}

/**
 * "approx · zone centre" beside a coordinate that is not the thing's own position.
 *
 * The word "approx" as well as the label, because the label alone ("zone centre") reads as a
 * description of the place rather than a warning about the number. Colour is not carrying any
 * of it: this is a `<small>` with words in it, legible to a screen reader reading the cell and
 * to anyone who cannot distinguish the muted foreground from the normal one.
 */
function Precision<F extends SourceFeature>({
  layer,
  feature,
}: {
  layer: MapLayerDefinition<F>;
  feature: F;
}) {
  const precision = layer.precision?.(feature) ?? null;
  if (!precision) return null;
  return (
    <small className="ml-1 whitespace-nowrap font-sans text-xs text-muted-foreground">
      approx · {precision.label}
    </small>
  );
}

/**
 * A cell's contents.
 *
 * AN ABSENT VALUE IS AN EM DASH WITH A SCREEN-READER WORD, NEVER A BLANK CELL. A blank cell
 * is indistinguishable from a rendering failure, and on a live surface the difference between
 * "the source did not report this" and "we lost it" is exactly the difference a reader needs.
 * Carried over from `components/live/flights-table.tsx`.
 */
function Cell<F extends SourceFeature>({
  column,
  feature,
}: {
  column: TableColumn<F>;
  feature: F;
}) {
  const formatted = column.format ? column.format(feature) : null;
  const raw = formatted ?? column.value(feature);
  if (raw === null || raw === "") {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">not reported</span>
      </span>
    );
  }
  return <>{typeof raw === "number" ? String(raw) : raw}</>;
}
