"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  aircraftLabel,
  feetToMetres,
  formatAge,
  formatClockUtc,
  formatNumber,
  formatPosition,
  knotsToKmh,
  type Aircraft,
} from "./live-format";

/**
 * Detail panel for one aircraft. Intentionally a panel, not a route: a per-aircraft URL
 * would be a linkable record of a specific aircraft, which we don't keep.
 *
 * Only broadcast telemetry is shown. No owner/registration lookup, no track history.
 */

export interface AircraftPanelProps {
  aircraft: Aircraft;
  /** ISO instant the payload was fetched, for the "as of" line. */
  fetchedAt: string | null;
  fetchedAgeSeconds: number | null;
  onClose: () => void;
}

export function AircraftPanel({ aircraft, fetchedAt, fetchedAgeSeconds, onClose }: AircraftPanelProps) {
  return (
    <aside
      aria-labelledby="aircraft-panel-heading"
      className="rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="aircraft-panel-heading" className="truncate font-mono text-lg font-semibold">
            {aircraftLabel(aircraft)}
          </h2>
          <p className="font-mono text-sm tabular text-muted-foreground">
            {aircraft.hex.toUpperCase()}
            <span className="sr-only"> — ICAO 24-bit address</span>
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Close aircraft details</span>
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="registration" value={aircraft.registration} mono />
        <Row label="type" value={aircraft.type} mono />
        <Row
          label="altitude"
          value={
            aircraft.onGround
              ? "on ground"
              : aircraft.altitudeFt === null
                ? null
                : `${formatNumber(aircraft.altitudeFt)} ft · ${formatNumber(feetToMetres(aircraft.altitudeFt))} m`
          }
        />
        <Row
          label="ground speed"
          value={
            aircraft.groundSpeedKt === null
              ? null
              : `${formatNumber(Math.round(aircraft.groundSpeedKt))} kt · ${formatNumber(knotsToKmh(aircraft.groundSpeedKt))} km/h`
          }
        />
        <Row
          label="heading"
          value={aircraft.trackDeg === null ? null : `${Math.round(aircraft.trackDeg)}°`}
        />
        <Row label="position" value={formatPosition(aircraft.lat, aircraft.lon)} mono />
        <Row label="squawk" value={aircraft.squawk} mono />
        {aircraft.emergency ? <Row label="emergency" value={aircraft.emergency} /> : null}
        <Row
          label="position age"
          value={
            aircraft.positionAgeSeconds === null
              ? null
              : `${Math.round(aircraft.positionAgeSeconds)}s since this aircraft was last heard`
          }
        />
        <Row
          label="as of"
          value={
            fetchedAt
              ? `${formatClockUtc(fetchedAt)}${fetchedAgeSeconds === null ? "" : ` · ${formatAge(fetchedAgeSeconds)}`}`
              : null
          }
        />
      </dl>

      <p className="mt-4 text-sm leading-relaxed text-foreground-secondary">
        We add no identity resolution and keep no history of this aircraft.
      </p>
    </aside>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono tabular" : "tabular"}>
        {value ?? (
          <span className="text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">not broadcast</span>
          </span>
        )}
      </dd>
    </>
  );
}
