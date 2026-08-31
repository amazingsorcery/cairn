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
 * The primary, always-present surface of `/live/flights`. ADR 0016 §1.
 *
 * "Table first because it is the accessible path, it works with no JavaScript map at all,
 * and it is genuinely the better interface for 'which aircraft are these'."
 *
 * It is a REAL `<table>`: a `<caption>`, `scope="col"` headers, one row per aircraft. It is
 * scanned, sorted and compared, which are the three things a table is for. Sorting is a
 * `<button>` inside each `<th>`, so it is reachable and operable from the keyboard, and the
 * `<th>` carries `aria-sort` so a screen reader can report the current order without the
 * reader having to infer it from an icon.
 *
 * Sort changes are announced through the route's single `aria-live` region, which the
 * surface owns — not from here. More than one live region per route and a screen reader
 * queues announcements from regions the reader is not looking at
 * (`docs/frontend/HANDOFF-shell.md` §10.1).
 *
 * UNITS ARE THE BROADCAST UNITS. ADS-B transmits altitude in feet and ground speed in
 * knots, and an investigator quoting a figure should be quoting what the aircraft actually
 * said. The detail panel converts as well as reports; this table does not, because a
 * silently converted number in a scanning surface is a number nobody can trace back.
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

/**
 * Nulls always sort last, in both directions.
 *
 * An aircraft that broadcasts no callsign is not "before A" or "after Z" — it is an absence,
 * and floating absences to the top of a descending sort would bury the data the reader asked
 * to see under the rows that have none of it.
 */
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
    // A stable tiebreak on the ICAO 24-bit address, which is unique and always present, so
    // the row order does not shuffle between refreshes for equal values.
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

/**
 * An absent value is an em dash with a screen-reader word, never a blank cell. A blank cell
 * is indistinguishable from a rendering failure, and on this surface the difference between
 * "not broadcast" and "we lost it" matters.
 */
function emptyCell() {
  return (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">not broadcast</span>
    </span>
  );
}
