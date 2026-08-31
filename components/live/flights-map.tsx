"use client";

import "leaflet/dist/leaflet.css";

import * as React from "react";
import L from "leaflet";
import { Minus, Plus } from "lucide-react";

import { mapTiles } from "@/config/live";
import { cn } from "@/lib/utils";
import type { Aircraft } from "./live-format";

/**
 * The opt-in map layer for `/live/flights`. ADR 0016 §1.
 *
 * FOUR THINGS ABOUT THIS FILE ARE LOAD-BEARING AND EASY TO UNDO BY ACCIDENT.
 *
 * 1. **It is only ever reached through `next/dynamic(..., { ssr: false })`, after a click.**
 *    Leaflet and its CSS are ~42 KB that every other route would otherwise pay for, and — the
 *    part that is not about bundle size — a tile server sees the viewport a reader is looking
 *    at. That is precisely the leak the server-side flight proxy exists to prevent, so
 *    loading tiles on page load would close one leak and open another (ADR 0016 §1).
 *
 * 2. **No default Leaflet marker icons.** Leaflet's defaults resolve to image URLs on a CDN,
 *    which our generated CSP (`infra/csp.caddy`, ADR 0017) does not allow. They would work in
 *    development, where there is no CSP, and fail silently in production. Every marker here
 *    is an inline SVG in a `divIcon`, which needs no image request at all.
 *
 * 3. **The tile origin is `config/live.ts` and nothing else.** It is the single declaration
 *    the CSP generator reads. A hardcoded URL here would produce a map that works locally and
 *    is blocked in production, which is the whole defect class ADR 0017 exists to prevent.
 *
 * 4. **Attribution is rendered on the map, not in a page footer** (ADR 0011 rule 2). The
 *    OpenStreetMap tile usage policy requires it; `config/live.ts` also records that a
 *    deployment with real traffic must move to a paid or self-hosted provider.
 *
 * Markers are `keyboard: false` on purpose. The table is the accessible path (ADR 0016 §1);
 * making a reader tab through three hundred markers to reach the next control would be worse
 * service than the table already provides, and every aircraft here is a row there.
 */

export interface FlightsMapProps {
  aircraft: readonly Aircraft[];
  center: { lat: number; lon: number };
  /** Nautical miles. Used only to pick a sensible starting zoom. */
  radius: number;
  selectedHex: string | null;
  onSelect: (hex: string) => void;
  /** Fired after the reader stops panning, so the surface can ask our server for that area. */
  onViewportChange: (viewport: { lat: number; lon: number; radius: number }) => void;
}

/** Nautical miles to a starting zoom level. Coarse on purpose; the reader adjusts. */
function zoomForRadius(radiusNm: number): number {
  if (radiusNm <= 25) return 10;
  if (radiusNm <= 50) return 9;
  if (radiusNm <= 100) return 8;
  if (radiusNm <= 150) return 7;
  return 6;
}

/** Half the diagonal of the current view, in nautical miles — what the connector asks for. */
function viewRadiusNm(map: L.Map): number {
  const bounds = map.getBounds();
  const metres = bounds.getNorthWest().distanceTo(bounds.getSouthEast()) / 2;
  return Math.min(250, Math.max(1, Math.round(metres / 1852)));
}

/**
 * An aircraft marker: a triangle pointing along its track, or a circle when the aircraft
 * broadcasts no heading. Inline SVG, no image request, `currentColor` so it follows the
 * theme rather than needing a second asset for dark and light.
 */
function markerIcon(aircraft: Aircraft, selected: boolean): L.DivIcon {
  const rotation = aircraft.trackDeg ?? 0;
  const shape =
    aircraft.trackDeg === null
      ? '<circle cx="12" cy="12" r="5" />'
      : '<path d="M12 3 L18 20 L12 16 L6 20 Z" />';

  return L.divIcon({
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html:
      `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" ` +
      `style="transform: rotate(${rotation}deg); color: ${selected ? "var(--warning)" : "var(--primary)"};` +
      `filter: drop-shadow(0 0 1px var(--background))" fill="currentColor">${shape}</svg>`,
  });
}

export default function FlightsMap({
  aircraft,
  center,
  radius,
  selectedHex,
  onSelect,
  onViewportChange,
}: FlightsMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<L.Map | null>(null);
  const markersRef = React.useRef<Map<string, L.Marker>>(new Map());
  const onSelectRef = React.useRef(onSelect);
  const onViewportChangeRef = React.useRef(onViewportChange);

  onSelectRef.current = onSelect;
  onViewportChangeRef.current = onViewportChange;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    // `prefers-reduced-motion` turns off Leaflet's pan and zoom animations. Motion is a
    // vestibular trigger, not a decoration, and a map is one of the larger moving surfaces
    // a reader will meet.
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const map = L.map(container, {
      center: [center.lat, center.lon],
      zoom: zoomForRadius(radius),
      zoomControl: false,
      attributionControl: true,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion,
      keyboard: true,
    });

    L.tileLayer(mapTiles.urlTemplate, {
      maxZoom: mapTiles.maxZoom,
      attribution: `<a href="${mapTiles.attributionUrl}" rel="noreferrer">${mapTiles.attribution}</a>`,
    }).addTo(map);

    map.on("moveend", () => {
      const c = map.getCenter();
      onViewportChangeRef.current({ lat: c.lat, lon: c.lng, radius: viewRadiusNm(map) });
    });

    mapRef.current = map;

    // Captured now rather than read in the cleanup: by teardown `markersRef.current` may
    // point at a different Map, and clearing the wrong one would leak the old markers.
    const markersAtSetup = markersRef.current;

    return () => {
      map.remove();
      mapRef.current = null;
      markersAtSetup.clear();
    };
    /*
     * The centre and radius seed the initial view only. The guard at the top of the effect
     * makes a re-run a no-op, so these can stay in the dependency list honestly rather than
     * being suppressed: once the map exists the reader owns the viewport, and re-centring
     * under them would fight their panning.
     */
  }, [center.lat, center.lon, radius]);

  /** Reconcile markers against the current payload — add, move, remove. */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();

    for (const item of aircraft) {
      seen.add(item.hex);
      const existing = markersRef.current.get(item.hex);
      if (existing) {
        existing.setLatLng([item.lat, item.lon]);
        existing.setIcon(markerIcon(item, item.hex === selectedHex));
        continue;
      }
      const marker = L.marker([item.lat, item.lon], {
        icon: markerIcon(item, item.hex === selectedHex),
        // The table is the accessible path; three hundred focusable markers is not.
        keyboard: false,
        alt: item.callsign ?? item.hex.toUpperCase(),
      });
      marker.on("click", () => onSelectRef.current(item.hex));
      marker.addTo(map);
      markersRef.current.set(item.hex, marker);
    }

    for (const [hex, marker] of markersRef.current) {
      if (seen.has(hex)) continue;
      marker.remove();
      markersRef.current.delete(hex);
    }
  }, [aircraft, selectedHex]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        role="region"
        aria-label="Map of aircraft positions. The table below lists the same aircraft and is the equivalent surface."
        className="h-[60vh] min-h-[20rem] w-full rounded-lg border border-border bg-muted"
      />
      <div className="absolute bottom-3 right-3 z-[var(--z-sticky)] flex flex-col gap-1">
        <ZoomButton label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          <Plus className="size-4" aria-hidden="true" />
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          <Minus className="size-4" aria-hidden="true" />
        </ZoomButton>
      </div>
    </div>
  );
}

/**
 * Our own zoom controls rather than Leaflet's, for one reason: Leaflet's are 26 px and the
 * accessibility floor in this product is 44 (`HANDOFF-shell.md` §10.4).
 */
function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-md border border-border",
        "bg-background text-foreground shadow-sm hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}
