"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  aircraftLabel,
  formatNumber,
  formatPosition,
  type Aircraft,
} from "./live-format";

/**
 * The primary surface of `/live/flights`: a real `<table>` with a caption, `scope` headers,
 * and sort buttons inside each `<th>` (which carries `aria-sort`).
 *
 * Sort changes are announced by the surface's single live region, not from here.
 *
 * Units are as broadcast (ft, kt); only the detail panel converts.
 */

export type FlightSortKey =
  | "callsign"
  | "registration"
  | "type"
  | "altitudeFt"
  | "groundSpeedKt"
  | "trackDeg"
  | "positionAgeSeconds";

export type SortDirection = "asc" | "desc";

export interface FlightSort {
  key: FlightSortKey;
  direction: SortDirection;
}

interface ColumnDef {
  key: FlightSortKey;
  label: string;
  /** Right-aligned numerics; left-aligned text. */
  numeric: boolean;
}

const COLUMNS: readonly ColumnDef[] = [
  { key: "callsign", label: "callsign", numeric: false },
  { key: "registration", label: "registration", numeric: false },
  { key: "type", label: "type", numeric: false },
  { key: "altitudeFt", label: "altitude (ft)", numeric: true },
  { key: "groundSpeedKt", label: "ground speed (kt)", numeric: true },
  { key: "trackDeg", label: "heading (°)", numeric: true },
  { key: "positionAgeSeconds", label: "position age (s)", numeric: true },
] as const;

const ARIA_SORT: Record<SortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

/** Human wording for the live-region announcement the surface makes. */
export function sortDescription(sort: FlightSort): string {
  const column = COLUMNS.find((c) => c.key === sort.key);
  return `Sorted by ${column?.label ?? sort.key}, ${ARIA_SORT[sort.direction]}.`;
}

/** Nulls always sort last, in both directions. */
function compare(a: Aircraft, b: Aircraft, sort: FlightSort): number {
  const left = a[sort.key];
  const right = b[sort.key];

  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), "en");

  return sort.direction === "asc" ? order : -order;
}

export function sortAircraft(aircraft: readonly Aircraft[], sort: FlightSort): Aircraft[] {
  return [...aircraft].sort((a, b) => {
    const result = compare(a, b, sort);
    // Tiebreak on the ICAO hex so rows don't shuffle between refreshes.
    return result !== 0 ? result : a.hex.localeCompare(b.hex, "en");
  });
}

export interface FlightsTableProps {
  aircraft: readonly Aircraft[];
  sort: FlightSort;
  onSortChange: (sort: FlightSort) => void;
  selectedHex: string | null;
  onSelect: (hex: string) => void;
  /** Rendered as the table's caption — the accessible name for the whole table. */
  caption: string;
}

export function FlightsTable({
  aircraft,
  sort,
  onSortChange,
  selectedHex,
  onSelect,
  caption,
}: FlightsTableProps) {
  const sorted = React.useMemo(() => sortAircraft(aircraft, sort), [aircraft, sort]);

  function toggle(key: FlightSortKey) {
    onSortChange(
      sort.key === key
        ? { key, direction: sort.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "callsign" || key === "registration" || key === "type" ? "asc" : "desc" },
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? ARIA_SORT[sort.direction] : "none"}
                  className={cn("p-0 font-medium", column.numeric ? "text-right" : "text-left")}
                >
                  <button
                    type="button"
                    onClick={() => toggle(column.key)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-1.5 px-3 py-2",
                      "text-xs uppercase tracking-wide text-muted-foreground",
                      "hover:text-foreground focus-visible:outline-none focus-visible:ring-2",
                      "focus-visible:ring-inset focus-visible:ring-ring",
                      "motion-reduce:transition-none",
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
            })}
            <th scope="col" className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
              position
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((item) => (
            <tr
              key={item.hex}
              className={cn(
                "border-b border-border last:border-0",
                selectedHex === item.hex && "bg-accent",
              )}
            >
              <th scope="row" className="p-0 text-left font-normal">
                <button
                  type="button"
                  onClick={() => onSelect(item.hex)}
                  aria-pressed={selectedHex === item.hex}
                  className={cn(
                    "flex min-h-11 w-full items-center px-3 py-2 font-mono font-semibold",
                    "underline-offset-4 hover:underline",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                >
                  {aircraftLabel(item)}
                  <span className="sr-only"> — show details</span>
                </button>
              </th>
              <td className="px-3 py-2 font-mono">{item.registration ?? emptyCell()}</td>
              <td className="px-3 py-2 font-mono">{item.type ?? emptyCell()}</td>
              <td className="px-3 py-2 text-right tabular">
                {item.onGround ? "on ground" : item.altitudeFt === null ? emptyCell() : formatNumber(item.altitudeFt)}
              </td>
              <td className="px-3 py-2 text-right tabular">
                {item.groundSpeedKt === null ? emptyCell() : formatNumber(Math.round(item.groundSpeedKt))}
              </td>
              <td className="px-3 py-2 text-right tabular">
                {item.trackDeg === null ? emptyCell() : Math.round(item.trackDeg)}
              </td>
              <td className="px-3 py-2 text-right tabular">
                {item.positionAgeSeconds === null ? emptyCell() : Math.round(item.positionAgeSeconds)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular">
                {formatPosition(item.lat, item.lon)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Em dash plus screen-reader text, so a missing value doesn't look like a render failure. */
function emptyCell() {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">not broadcast</span>
    </span>
  );
}
