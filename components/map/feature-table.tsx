"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, TableColumn, TableSort } from "./registry";
import { featurePrecision } from "./registry";
import { ARIA_SORT, nextSort, sortFeatures } from "./sort";

/**
 * Accessible table equivalent of a map layer, not a fallback.
 *
 * - No deck.gl/MapLibre imports, so it works without WebGL.
 * - Server-rendered: every row is in the initial HTML; JS adds sorting and the detail panel.
 * - Real `<table>` with caption, `scope` headers, sort buttons in `<th>` with `aria-sort`.
 *
 * Columns and formatting come from the layer registry. Sort changes are announced by
 * `map-surface.tsx`'s live region, not from here.
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

  /* One row-header column, falling back to the first so every row has a `<th scope="row">`. */
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
               * Index in the key because NWS alerts reuse one id across every zone an alert
               * covers, and duplicate keys make React drop rows. Stable since the sort is
               * stable. The proper fix belongs in the adapter.
               */
              key={`${feature.id}::${index}`}
              className={cn(
                "border-b border-border last:border-0",
                selectedId === feature.id && "bg-accent",
              )}
            >
              <th scope="row" className="p-0 text-left font-normal">
                {/* The row header doubles as the open control, to avoid an extra tab stop per row. */}
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
                {/* Precision caveat sits in the same cell as the coordinate. */}
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
 * "approx · zone centre" beside an approximate coordinate. "approx" is included because the
 * label alone reads like a place description.
 */
function Precision<F extends SourceFeature>({
  layer,
  feature,
}: {
  layer: MapLayerDefinition<F>;
  feature: F;
}) {
  const precision = featurePrecision(layer, feature);
  if (!precision) return null;
  return (
    <small className="ml-1 whitespace-nowrap font-sans text-xs text-muted-foreground">
      approx · {precision.label}
    </small>
  );
}

/** A cell's contents. Missing values render as an em dash with screen-reader text, not blank. */
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
