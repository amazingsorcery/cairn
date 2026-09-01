"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/**
 * NAMED IMPORTS, not a default. `maplibre-gl@6` ships an ESM build with no default export;
 * `import maplibregl from "maplibre-gl"` typechecks under some bundler settings and is
 * `undefined` at runtime.
 */
import { AttributionControl, GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";

import { basemap, basemapStyleUrl } from "@/components/map/basemap";
import { readTheme, type Theme } from "@/components/layout/theme";
import { OSM_ATTRIBUTION, type BoundingBox, type OverpassFeature } from "@/lib/toolbench/overpass";

/**
 * The Overpass results, on a map.
 *
 * ── WHY MAPLIBRE HERE AND LEAFLET ELSEWHERE IN THIS DIRECTORY ──────────────
 * The Toolbench's older preview maps use Leaflet because MapLibre needs `connect-src`
 * widened to the tile origin, and that was not the tools engineer's call to make
 * (`HANDOFF-toolbench.md` §4.1). It has since been made elsewhere: the Live Map runs on
 * MapLibre and the generated CSP already carries `connect-src 'self'
 * https://tiles.openfreemap.org`, `img-src` for the same origin, and `worker-src blob:`. So
 * this costs no new policy at all — and the basemap it needs IS OpenStreetMap, which is the
 * data the results came from.
 *
 * ── THE WORKER, WHICH IS THE PART THAT FAILS SILENTLY ──────────────────────
 * `maplibre-gl@6` locates its worker with a dynamic `new URL(...)` that webpack never emits,
 * so it asks for a chunk that does not exist and — because vector tiles are parsed IN the
 * worker — never issues a single tile request. No error, no failed image: a blank rectangle
 * that reads as a styling bug. `scripts/copy-maplibre-assets.ts` copies the files into
 * `public/maplibre/` at `prebuild`; this points at them, at module scope, because MapLibre
 * reads the value when it builds its worker pool.
 *
 * ── CLICK TO LOAD ──────────────────────────────────────────────────────────
 * This module is only imported after the reader asks for the map, for the reason ADR 0015
 * gives and which is sharper here: the tiles requested are the search area.
 */
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
setWorkerUrl(WORKER_URL);

export interface OsmResultMapProps {
  readonly features: readonly OverpassFeature[];
  readonly bbox: BoundingBox;
  readonly selectedId: string | null;
  readonly onSelect: (featureId: string) => void;
  /** Fired on `moveend`, so the page can offer "use this view as the bounding box". */
  readonly onViewportChange: (box: BoundingBox) => void;
}

const RESULT_SOURCE = "overpass-results";
const BOX_SOURCE = "overpass-bbox";
const RESULT_LAYER = "overpass-results-circle";
const SELECTED_LAYER = "overpass-results-selected";
const BOX_LAYER = "overpass-bbox-line";

function resultCollection(features: readonly OverpassFeature[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [feature.longitude, feature.latitude] },
      properties: { id: feature.id, label: feature.label },
    })),
  };
}

function boxCollection(box: BoundingBox): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [box.west, box.south],
            [box.east, box.south],
            [box.east, box.north],
            [box.west, box.north],
            [box.west, box.south],
          ],
        },
        properties: {},
      },
    ],
  };
}

/**
 * Add the bounding box and the results to whichever style is currently loaded.
 *
 * Called on `load` and again after every `setStyle`. MapLibre discards all sources and
 * layers when a style is replaced, so a theme switch that did not re-add them would leave a
 * correctly themed basemap with no results on it — which looks exactly like a query that
 * returned nothing.
 */
function installOverlays(
  map: MapLibreMap,
  bbox: BoundingBox,
  features: readonly OverpassFeature[],
  selectedId: string | null,
): void {
  if (!map.getSource(BOX_SOURCE)) {
    map.addSource(BOX_SOURCE, { type: "geojson", data: boxCollection(bbox) });
  }
  if (!map.getLayer(BOX_LAYER)) {
    map.addLayer({
      id: BOX_LAYER,
      type: "line",
      source: BOX_SOURCE,
      paint: { "line-color": "#facc15", "line-width": 2, "line-dasharray": [2, 2] },
    });
  }
  if (!map.getSource(RESULT_SOURCE)) {
    map.addSource(RESULT_SOURCE, { type: "geojson", data: resultCollection(features) });
  }
  if (!map.getLayer(RESULT_LAYER)) {
    map.addLayer({
      id: RESULT_LAYER,
      type: "circle",
      source: RESULT_SOURCE,
      paint: {
        "circle-radius": 6,
        "circle-color": "#38bdf8",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#0f172a",
      },
    });
  }
  if (!map.getLayer(SELECTED_LAYER)) {
    map.addLayer({
      id: SELECTED_LAYER,
      type: "circle",
      source: RESULT_SOURCE,
      filter: ["==", ["get", "id"], selectedId ?? ""],
      paint: {
        "circle-radius": 12,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#f8fafc",
      },
    });
  }
}

export default function OsmResultMap({
  features,
  bbox,
  selectedId,
  onSelect,
  onViewportChange,
}: OsmResultMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const [ready, setReady] = React.useState(false);
  const [basemapFailed, setBasemapFailed] = React.useState(false);
  /**
   * `null` until the document's theme has been read. The map is not created before then:
   * MapLibre loads a whole style file rather than following a CSS custom property, so a map
   * built against the default theme would be a dark basemap on a light page until the reader
   * toggled something.
   */
  const [theme, setTheme] = React.useState<Theme | null>(null);

  /* Refs so that a changing callback does not tear the map down and lose the reader's pan. */
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const onViewportChangeRef = React.useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const dataRef = React.useRef({ bbox, features, selectedId });
  /** The style URL currently applied, so a re-render cannot re-apply the same one. */
  const appliedStyleRef = React.useRef<string | null>(null);
  dataRef.current = { bbox, features, selectedId };

  React.useEffect(() => {
    setTheme(readTheme());
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || theme === null) return;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const initial = dataRef.current;
    // Record what the map is actually built with, so the theme effect below does not
    // immediately re-apply the same style — a wasted fetch and a needless overlay reinstall
    // on every first render.
    appliedStyleRef.current = basemapStyleUrl(theme === "light" ? "light" : "dark");

    const map = new MapLibreMap({
      container,
      style: basemapStyleUrl(theme === "light" ? "light" : "dark"),
      bounds: [
        [initial.bbox.west, initial.bbox.south],
        [initial.bbox.east, initial.bbox.north],
      ],
      fitBoundsOptions: { padding: 32, animate: false },
      maxZoom: basemap.maxZoom,
      attributionControl: false,
    });

    /**
     * Attribution ON THE MAP, never in a page footer. Two obligations are met here and both
     * are licence conditions rather than politeness: OpenFreeMap and OpenMapTiles for the
     * basemap, and ODbL for the OpenStreetMap data behind both the basemap and the results.
     */
    map.addControl(
      new AttributionControl({
        compact: false,
        customAttribution: [
          ...basemap.attribution.map(
            (item) => `<a href="${item.href}" rel="noreferrer" target="_blank">${item.text}</a>`,
          ),
          OSM_ATTRIBUTION,
        ],
      }),
      "bottom-right",
    );

    // Motion is a vestibular trigger, not a decoration, and a map is a large moving surface.
    if (reducedMotion) map.scrollZoom.disable();

    map.on("error", () => {
      // A dead tile host costs the reader the background and nothing else — the results are
      // still in the table below. What it must not do is fail silently: a blank rectangle
      // reads as a styling bug rather than as missing geography.
      setBasemapFailed(true);
    });

    const install = () => {
      const current = dataRef.current;
      installOverlays(map, current.bbox, current.features, current.selectedId);
      setReady(true);
    };

    map.on("load", install);

    map.on("click", RESULT_LAYER, (event: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      const id = event.features?.[0]?.properties?.["id"];
      if (typeof id === "string") onSelectRef.current(id);
    });
    map.on("mouseenter", RESULT_LAYER, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", RESULT_LAYER, () => {
      map.getCanvas().style.cursor = "";
    });

    map.on("moveend", () => {
      const bounds = map.getBounds();
      onViewportChangeRef.current({
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast(),
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [theme]);

  /*
   * Swap the basemap when the reader changes theme, keeping the map and its viewport.
   *
   * The overlays are re-added with `once("styledata")` immediately after `setStyle`, NOT with
   * a persistent `on("styledata")` guarded by `isStyleLoaded()`. On maplibre-gl@6 every
   * `styledata` event following a `setStyle` reports `isStyleLoaded()` false, so that guard
   * never opens and the overlays are simply never restored.
   *
   * The failure is silent, which is why it needs the comment. The new basemap draws
   * correctly, and the marker survives because markers are DOM rather than style — so the
   * only thing missing is the bounding box and the result circles. An Overpass results map
   * with no results on it reads as a query that matched nothing. No error, nothing in the
   * console. Found by looking at a screenshot taken after a theme toggle.
   */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || theme === null) return;

    const applied = appliedStyleRef.current;
    const next = basemapStyleUrl(theme === "light" ? "light" : "dark");
    // Without this the effect fires on the first theme resolution and re-applies the style
    // the map was built with one tick earlier — a wasted style fetch and a needless reinstall.
    if (applied === next) return;
    appliedStyleRef.current = next;

    map.setStyle(next);
    map.once("styledata", () => {
      installOverlays(map, dataRef.current.bbox, dataRef.current.features, dataRef.current.selectedId);
    });
  }, [theme]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(RESULT_SOURCE);
    if (source instanceof GeoJSONSource) source.setData(resultCollection(features));
  }, [features, ready]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(BOX_SOURCE);
    if (source instanceof GeoJSONSource) source.setData(boxCollection(bbox));
  }, [bbox, ready]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !map.getLayer(SELECTED_LAYER)) return;
    map.setFilter(SELECTED_LAYER, ["==", ["get", "id"], selectedId ?? ""]);
  }, [selectedId, ready]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        role="region"
        aria-label="Map of the query results. Every result is also listed in the table below this map, which is the equivalent surface and is complete whether or not the map loads."
        className="h-[26rem] w-full overflow-hidden rounded-lg border border-border bg-muted"
      />
      {basemapFailed ? (
        <p
          role="status"
          className="absolute inset-x-2 top-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground-secondary"
        >
          The background map could not be loaded from the tile host. The result positions are
          unaffected and the table below is complete.
        </p>
      ) : null}
    </div>
  );
}
