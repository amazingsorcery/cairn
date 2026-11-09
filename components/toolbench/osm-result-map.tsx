"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/** Named imports: `maplibre-gl@6` ESM has no default export (undefined at runtime). */
import { AttributionControl, GeoJSONSource, Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";

import { basemap, basemapStyleUrl } from "@/components/map/basemap";
import { readTheme, type Theme } from "@/components/layout/theme";
import { OSM_ATTRIBUTION, type BoundingBox, type OverpassFeature } from "@/lib/toolbench/overpass";

/**
 * Overpass results on a map. MapLibre here (other Toolbench maps use Leaflet) because the
 * CSP already allows the OpenFreeMap origin in `connect-src`/`img-src` and `worker-src blob:`
 * for the Live Map.
 *
 * Worker: MapLibre's dynamic worker URL isn't emitted by webpack, and without a worker no
 * tiles load (silently). `scripts/copy-maplibre-assets.ts` copies it to `public/maplibre/`
 * on prebuild; set at module scope, before any map is created.
 *
 * Only imported after the reader asks for the map, since the tiles reveal the search area.
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
 * Add the bbox and results to the current style. Called on `load` and after every
 * `setStyle`, which discards all sources and layers.
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
  /** `null` until the theme is read; the map waits for it so it starts with the right style. */
  const [theme, setTheme] = React.useState<Theme | null>(null);

  /* Refs so a changing callback doesn't rebuild the map and lose the pan. */
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
    // Record the initial style so the theme effect doesn't immediately re-apply it.
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

    /* Attribution on the map (licence requirement): basemap credits plus ODbL for OSM data. */
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

    if (reducedMotion) map.scrollZoom.disable();

    map.on("error", () => {
      // Show a notice rather than a silently blank basemap; results are still in the table.
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
   * Swap the basemap on theme change, keeping the viewport. Overlays are re-added with
   * `once("styledata")`: on maplibre-gl@6 `isStyleLoaded()` is false for every `styledata`
   * after `setStyle`, so an `on` handler guarded by it never re-adds them.
   */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || theme === null) return;

    const applied = appliedStyleRef.current;
    const next = basemapStyleUrl(theme === "light" ? "light" : "dark");
    // Skip if this is the style the map was just built with.
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
