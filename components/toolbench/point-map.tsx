"use client";

import "leaflet/dist/leaflet.css";

import * as React from "react";
import L from "leaflet";

import { mapTiles } from "@/config/live";

/**
 * A single-point map preview for the coordinate and metadata tools.
 *
 * FOUR THINGS HERE ARE LOAD-BEARING. They mirror `components/live/flights-map.tsx`, and for
 * the same reasons.
 *
 * 1. **It is only ever reached through `next/dynamic(..., { ssr: false })`, after a click.**
 *    A tile server sees the viewport a reader is looking at, and on a coordinate tool that
 *    viewport *is* the investigation. Loading tiles automatically would take a workbench
 *    that discloses nothing and make it disclose the one thing that matters. The wrapper in
 *    `map-preview.tsx` holds that click gate.
 *
 * 2. **No default Leaflet marker icons.** Leaflet's defaults resolve to image URLs on a CDN
 *    that the generated CSP (`infra/csp.caddy`, ADR 0017) does not allow. They work in
 *    development and fail silently in production. The marker below is an inline SVG.
 *
 * 3. **The tile origin comes from `config/live.ts` and nowhere else.** That file is the
 *    single declaration the CSP generator reads. A hardcoded URL here produces a map that
 *    works locally and is blocked in production.
 *
 * 4. **Attribution is on the map, not in a page footer.** The OpenStreetMap tile usage
 *    policy requires it at the point of display.
 *
 * Leaflet rather than MapLibre: the raster tiles Leaflet requests are `<img>` loads, which
 * the deployed `img-src` already permits, whereas MapLibre fetches tiles through XHR and
 * would need `connect-src` widened. Widening the CSP for a preview map is not this tool's
 * call to make — see `docs/frontend/HANDOFF-toolbench.md`.
 */

export interface PointMapProps {
  readonly latitude: number;
  readonly longitude: number;
  /** Announced to screen readers and used as the marker's alt text. */
  readonly label: string;
  /** Radius in metres of the area the coordinate actually names, drawn as a circle. */
  readonly accuracyMetres?: number;
  readonly zoom?: number;
}

function markerIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    html:
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" ' +
      'style="color: var(--primary); filter: drop-shadow(0 0 1px var(--background))" fill="currentColor">' +
      '<path d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />' +
      "</svg>",
  });
}

export default function PointMap({
  latitude,
  longitude,
  label,
  accuracyMetres,
  zoom = 15,
}: PointMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<L.Map | null>(null);
  const markerRef = React.useRef<L.Marker | null>(null);
  const circleRef = React.useRef<L.Circle | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    // Motion is a vestibular trigger, not a decoration, and a map is one of the larger
    // moving surfaces a reader meets.
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const map = L.map(container, {
      center: [latitude, longitude],
      zoom,
      zoomControl: true,
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

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // The centre and zoom seed the initial view only; the guard above makes a re-run a
    // no-op, so these can stay in the dependency list honestly. Once the map exists the
    // reader owns the viewport and re-centring under them would fight their panning.
  }, [latitude, longitude, zoom]);

  /** Move the marker as the coordinate changes, without tearing the map down. */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) {
      markerRef.current.setLatLng([latitude, longitude]);
    } else {
      markerRef.current = L.marker([latitude, longitude], {
        icon: markerIcon(),
        keyboard: false,
        alt: label,
      }).addTo(map);
    }

    if (accuracyMetres !== undefined && accuracyMetres > 1) {
      if (circleRef.current) {
        circleRef.current.setLatLng([latitude, longitude]).setRadius(accuracyMetres);
      } else {
        circleRef.current = L.circle([latitude, longitude], {
          radius: accuracyMetres,
          color: "var(--primary)",
          weight: 1,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(map);
      }
    } else if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }

    map.setView([latitude, longitude], map.getZoom(), { animate: false });
  }, [latitude, longitude, label, accuracyMetres]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={`Map showing ${label}. The coordinate is written out in full above this map, which is the equivalent surface.`}
      className="h-[22rem] w-full rounded-lg border border-border bg-muted"
    />
  );
}
