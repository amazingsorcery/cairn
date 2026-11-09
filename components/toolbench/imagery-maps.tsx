"use client";

import "leaflet/dist/leaflet.css";

import * as React from "react";
import L from "leaflet";

import {
  findImageryLayer,
  GIBS_ACKNOWLEDGEMENT,
  imageryTileTemplate,
  REFERENCE_LAYERS,
  referenceTileTemplate,
} from "@/lib/toolbench/imagery";

/**
 * Two synchronised satellite views of one place on two dates.
 *
 * Only imported after a click: tiles come straight from `gibs.earthdata.nasa.gov`, which
 * sees the reader's IP and the area being examined. `imagery-tool.tsx` discloses this first.
 *
 * Leaflet because GIBS tiles load as `<img>` (CSP `img-src` only); MapLibre would also need
 * `connect-src`.
 *
 * Both maps are always built; swipe mode just stacks and clips them, so there's one sync path.
 */

export type ImageryMode = "sideBySide" | "swipe";

export interface ImageryView {
  readonly latitude: number;
  readonly longitude: number;
  readonly zoom: number;
}

export interface ImageryPaneSpec {
  readonly layerId: string;
  readonly date: string;
}

export interface ImageryMapsProps {
  readonly left: ImageryPaneSpec;
  readonly right: ImageryPaneSpec;
  readonly mode: ImageryMode;
  /** 0–100. Where the swipe divider sits, from the left edge. */
  readonly swipePercent: number;
  readonly view: ImageryView;
  readonly references: readonly string[];
  /** Reports the viewport back so the page can show the scale and offer "use this view". */
  readonly onViewChange: (view: ImageryView) => void;
}

/**
 * Transparent 1×1 PNG for tiles GIBS 404s (no data between swaths or over the winter pole),
 * instead of broken-image glyphs. `data:` is allowed by `img-src`.
 */
const BLANK_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Beyond the deepest native zoom Leaflet upsamples; the page says so rather than hiding it. */
const MAX_MAP_ZOOM = 12;

function buildPane(
  map: L.Map,
  spec: ImageryPaneSpec,
  references: readonly string[],
): L.Layer[] {
  const layers: L.Layer[] = [];
  const layer = findImageryLayer(spec.layerId);
  if (layer) {
    layers.push(
      L.tileLayer(imageryTileTemplate(layer, spec.date), {
        maxNativeZoom: layer.maxNativeZoom,
        maxZoom: MAX_MAP_ZOOM,
        errorTileUrl: BLANK_TILE,
        // GIBS's requested acknowledgement, on the map.
        attribution: GIBS_ACKNOWLEDGEMENT,
        crossOrigin: false,
      }).addTo(map),
    );
  }

  for (const reference of REFERENCE_LAYERS) {
    if (!references.includes(reference.id)) continue;
    layers.push(
      L.tileLayer(referenceTileTemplate(reference), {
        maxNativeZoom: reference.maxNativeZoom,
        maxZoom: MAX_MAP_ZOOM,
        errorTileUrl: BLANK_TILE,
        crossOrigin: false,
      }).addTo(map),
    );
  }

  return layers;
}

export default function ImageryMaps({
  left,
  right,
  mode,
  swipePercent,
  view,
  references,
  onViewChange,
}: ImageryMapsProps) {
  const leftRef = React.useRef<HTMLDivElement | null>(null);
  const rightRef = React.useRef<HTMLDivElement | null>(null);
  const mapsRef = React.useRef<{ left: L.Map; right: L.Map } | null>(null);
  const layersRef = React.useRef<{ left: L.Layer[]; right: L.Layer[] }>({ left: [], right: [] });
  /** Guards the two-way sync so an echoed `move` does not bounce between the maps forever. */
  const syncingRef = React.useRef(false);
  const onViewChangeRef = React.useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  /* Create the two maps once. */
  React.useEffect(() => {
    const leftEl = leftRef.current;
    const rightEl = rightRef.current;
    if (!leftEl || !rightEl || mapsRef.current) return;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const options: L.MapOptions = {
      center: [view.latitude, view.longitude],
      zoom: view.zoom,
      minZoom: 1,
      maxZoom: MAX_MAP_ZOOM,
      zoomControl: true,
      attributionControl: true,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      // Arrow keys pan, +/- zoom.
      keyboard: true,
      worldCopyJump: true,
    };

    const leftMap = L.map(leftEl, options);
    const rightMap = L.map(rightEl, options);
    mapsRef.current = { left: leftMap, right: rightMap };

    const sync = (from: L.Map, to: L.Map) => () => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      to.setView(from.getCenter(), from.getZoom(), { animate: false });
      syncingRef.current = false;
      const centre = from.getCenter();
      onViewChangeRef.current({
        latitude: centre.lat,
        longitude: centre.lng,
        zoom: from.getZoom(),
      });
    };

    leftMap.on("move zoom", sync(leftMap, rightMap));
    rightMap.on("move zoom", sync(rightMap, leftMap));

    return () => {
      leftMap.remove();
      rightMap.remove();
      mapsRef.current = null;
      layersRef.current = { left: [], right: [] };
    };
    // Seeded once; later `view` changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Rebuild the tile layers whenever a date, a layer or the reference set changes. */
  React.useEffect(() => {
    const maps = mapsRef.current;
    if (!maps) return;

    for (const layer of layersRef.current.left) maps.left.removeLayer(layer);
    for (const layer of layersRef.current.right) maps.right.removeLayer(layer);

    layersRef.current = {
      left: buildPane(maps.left, left, references),
      right: buildPane(maps.right, right, references),
    };
  }, [left, right, references]);

  /**
   * Apply a viewport set from outside the map (typed coordinate, zoom field). Skips values
   * that echo the map's own position, which would otherwise `setView` mid-drag.
   */
  React.useEffect(() => {
    const maps = mapsRef.current;
    if (!maps) return;
    const centre = maps.left.getCenter();
    const sameCentre =
      Math.abs(centre.lat - view.latitude) < 1e-6 && Math.abs(centre.lng - view.longitude) < 1e-6;
    if (sameCentre && maps.left.getZoom() === view.zoom) return;

    syncingRef.current = true;
    maps.left.setView([view.latitude, view.longitude], view.zoom, { animate: false });
    maps.right.setView([view.latitude, view.longitude], view.zoom, { animate: false });
    syncingRef.current = false;
  }, [view]);

  /* Leaflet measures its container on creation; a mode change resizes both boxes. */
  React.useEffect(() => {
    const maps = mapsRef.current;
    if (!maps) return;
    const timer = window.setTimeout(() => {
      maps.left.invalidateSize();
      maps.right.invalidateSize();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mode]);

  if (mode === "swipe") {
    return (
      <div className="relative h-[28rem] w-full overflow-hidden rounded-lg border border-border">
        <div
          ref={leftRef}
          role="region"
          aria-label="Earlier date, satellite imagery"
          className="absolute inset-0"
        />
        <div
          ref={rightRef}
          role="region"
          aria-label="Later date, satellite imagery, revealed to the right of the divider"
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${swipePercent}%)` }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-[500] w-0.5 bg-primary"
          style={{ left: `${swipePercent}%` }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div
        ref={leftRef}
        role="region"
        aria-label="Earlier date, satellite imagery"
        className="h-[28rem] w-full rounded-lg border border-border bg-muted"
      />
      <div
        ref={rightRef}
        role="region"
        aria-label="Later date, satellite imagery"
        className="h-[28rem] w-full rounded-lg border border-border bg-muted"
      />
    </div>
  );
}
