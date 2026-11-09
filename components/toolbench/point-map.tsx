"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/* Named imports: `maplibre-gl@6` ESM has no default export (undefined at runtime). */
import { GeoJSONSource, Map as MapLibreMap, Marker, setWorkerUrl } from "maplibre-gl";
import { Minus, Plus, TriangleAlert } from "lucide-react";

import { readTheme, type Theme } from "@/components/layout/theme";
import { mapTiles } from "@/config/live";
import { cn } from "@/lib/utils";

/**
 * Single-point map preview for the coordinate converter and the image metadata GPS fix.
 *
 * MapLibre because OpenFreeMap is vector-only (no raster endpoint for Leaflet). The CSP
 * already allows the tile origin and `worker-src blob:` for the Live Map.
 *
 * 1. Only loaded via `next/dynamic` after a click (`map-preview.tsx`): MapLibre is large,
 *    and tile requests reveal the coordinate.
 * 2. Worker URL set at module scope: MapLibre's dynamic worker URL isn't emitted by webpack,
 *    and without a worker no tiles load (silently). `scripts/copy-maplibre-assets.ts` copies
 *    it to `public/maplibre/` on prebuild.
 * 3. No marker image request: the pin is inline SVG and the accuracy ring is GeoJSON. A
 *    default marker URL would be blocked by the production CSP.
 * 4. Tile styles come only from `config/live.ts` (`mapTiles.styleUrls`, read by
 *    `scripts/generate-csp.ts`), picked by `data-theme`.
 * 5. The coordinate is always written out under the map, so a dead tile host loses nothing.
 */

const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
setWorkerUrl(WORKER_URL);

export interface PointMapProps {
  readonly latitude: number;
  readonly longitude: number;
  /** Announced to screen readers. Not always a coordinate — the metadata tool passes a file. */
  readonly label: string;
  /** Radius in metres of the area the coordinate actually names, drawn as a ring. */
  readonly accuracyMetres?: number;
  readonly zoom?: number;
}

const ACCURACY_SOURCE = "point-accuracy";
const ACCURACY_FILL = "point-accuracy-fill";
const ACCURACY_LINE = "point-accuracy-line";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Metres per degree of latitude. Close enough for a ring drawn at street scale. */
const METRES_PER_DEGREE = 111_320;

/**
 * Accuracy ring as a polygon (world units; a `circle` layer is in pixels and would change
 * size with zoom). Equirectangular is accurate enough at these radii.
 */
function ringExtent(latitude: number, radiusMetres: number): { lat: number; lon: number } {
  /* Guard the pole: `cos(90°)` is zero and would send the longitude offset to infinity. */
  const cosLat = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  return {
    lat: radiusMetres / METRES_PER_DEGREE,
    lon: radiusMetres / (METRES_PER_DEGREE * cosLat),
  };
}

function accuracyRing(
  latitude: number,
  longitude: number,
  radiusMetres: number,
): GeoJSON.FeatureCollection {
  const steps = 64;
  const { lat: dLat, lon: dLon } = ringExtent(latitude, radiusMetres);

  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    ring.push([longitude + dLon * Math.cos(angle), latitude + dLat * Math.sin(angle)]);
  }

  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }],
  };
}

/** An empty collection, for when the coordinate carries no stated accuracy. */
const NO_RING: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Add the accuracy ring to the current style. Called on `load` and after every `setStyle`,
 * which discards sources and layers. The `Marker` is DOM and survives on its own.
 */
function installAccuracy(map: MapLibreMap, data: GeoJSON.FeatureCollection): void {
  if (!map.getSource(ACCURACY_SOURCE)) {
    map.addSource(ACCURACY_SOURCE, { type: "geojson", data });
  }
  if (!map.getLayer(ACCURACY_FILL)) {
    map.addLayer({
      id: ACCURACY_FILL,
      type: "fill",
      source: ACCURACY_SOURCE,
      paint: { "fill-color": "#38bdf8", "fill-opacity": 0.12 },
    });
  }
  if (!map.getLayer(ACCURACY_LINE)) {
    map.addLayer({
      id: ACCURACY_LINE,
      type: "line",
      source: ACCURACY_SOURCE,
      paint: { "line-color": "#38bdf8", "line-width": 1 },
    });
  }
}

/**
 * The marker as plain DOM, not JSX: MapLibre reparents the element, which would confuse
 * React. `createElementNS` avoids any HTML string.
 */
function createPinElement(): HTMLDivElement {
  const wrapper = document.createElement("div");
  /* The accessible surface is the coordinate in text below; the pin is decoration. */
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.width = "24px";
  wrapper.style.height = "24px";
  wrapper.style.color = "var(--primary)";
  wrapper.style.filter = "drop-shadow(0 0 1px var(--background))";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "currentColor");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z",
  );

  svg.appendChild(path);
  wrapper.appendChild(svg);
  return wrapper;
}

/** Five decimal places is about a metre — finer than any input this tool accepts. */
function formatCoordinate(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export default function PointMap({
  latitude,
  longitude,
  label,
  accuracyMetres,
  zoom = 15,
}: PointMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const markerRef = React.useRef<Marker | null>(null);
  const [ready, setReady] = React.useState(false);
  /* Show a notice on basemap failure rather than a silently blank map. */
  const [basemapFailed, setBasemapFailed] = React.useState(false);

  const reducedMotionRef = React.useRef(false);

  /** `null` until the theme is read; the map waits for it so it starts with the right style. */
  const [theme, setTheme] = React.useState<Theme | null>(null);
  const themeRef = React.useRef<Theme | null>(null);
  themeRef.current = theme;
  /** The style URL currently applied, so the swap effect doesn't re-apply the initial one. */
  const appliedStyleRef = React.useRef<string | null>(null);

  /** The ring data; also in a ref so a freshly swapped style can be seeded with it. */
  const ringData = React.useMemo(
    () =>
      accuracyMetres !== undefined && accuracyMetres > 1
        ? accuracyRing(latitude, longitude, accuracyMetres)
        : NO_RING,
    [latitude, longitude, accuracyMetres],
  );
  const ringDataRef = React.useRef(ringData);
  ringDataRef.current = ringData;

  /* Read the theme, then follow `data-theme` changes. */
  React.useEffect(() => {
    setTheme(readTheme());
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  /*
   * The create effect depends on `themeKnown`, not `theme`, so a theme change doesn't
   * rebuild the map; the style swap is handled by `setStyle` below.
   */
  const themeKnown = theme !== null;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || !themeKnown) return;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedMotionRef.current = reducedMotion;

    /* Frame an area-sized coordinate by its ring, so e.g. a 1 km MGRS square is visible whole. */
    const ring = accuracyMetres !== undefined && accuracyMetres > 1 ? ringExtent(latitude, accuracyMetres) : null;

    const initialStyle = mapTiles.styleUrls[themeRef.current ?? "dark"];
    appliedStyleRef.current = initialStyle;

    const map = new MapLibreMap({
      container,
      style: initialStyle,
      center: [longitude, latitude],
      zoom,
      ...(ring
        ? {
            bounds: [
              [longitude - ring.lon, latitude - ring.lat],
              [longitude + ring.lon, latitude + ring.lat],
            ] as [[number, number], [number, number]],
            fitBoundsOptions: { padding: 36, animate: false, maxZoom: zoom },
          }
        : {}),
      /* Our own controls; MapLibre's are 29px and we need 44px touch targets. */
      attributionControl: false,
      /* No rotation or pitch: two-finger only, and a rotated north is easy to misread. */
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      /* Arrow keys pan and +/- zoom once the canvas has focus. */
      keyboard: true,
      fadeDuration: reducedMotion ? 0 : 300,
    });

    map.touchZoomRotate.disableRotation();

    /* MapLibre reports style/worker/tile failures via `error` rather than throwing. */
    map.on("error", () => setBasemapFailed(true));

    const install = () => {
      installAccuracy(map, ringDataRef.current);
      setReady(true);
    };

    map.on("load", install);

    const marker = new Marker({ element: createPinElement(), anchor: "bottom" })
      .setLngLat([longitude, latitude])
      .addTo(map);

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      marker.remove();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      setReady(false);
    };
    // These only seed the view; the `mapRef` guard makes re-runs no-ops.
  }, [latitude, longitude, zoom, accuracyMetres, themeKnown]);

  /**
   * Swap the basemap on theme change via `setStyle` (keeps the viewport), then re-add the
   * ring with `once("styledata")`. An `on("styledata")` guarded by `isStyleLoaded()` doesn't
   * work: on maplibre-gl@6 it's false for every `styledata` after `setStyle`.
   */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || theme === null) return;
    const next = mapTiles.styleUrls[theme];
    if (appliedStyleRef.current === next) return;
    appliedStyleRef.current = next;
    map.setStyle(next);
    map.once("styledata", () => {
      installAccuracy(map, ringDataRef.current);
    });
  }, [theme]);

  /** Move the marker and re-centre as the coordinate changes, without rebuilding the map. */
  React.useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    marker.setLngLat([longitude, latitude]);
    /* `easeTo`, not `flyTo`, to avoid the zoom-out swoop. */
    map.easeTo({ center: [longitude, latitude], duration: reducedMotionRef.current ? 0 : 400 });
  }, [latitude, longitude]);

  /** The accuracy ring follows the coordinate, and disappears when there is no stated area. */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(ACCURACY_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData(ringData);
  }, [ringData, ready]);

  const zoomBy = React.useCallback((delta: 1 | -1) => {
    const map = mapRef.current;
    if (!map) return;
    const options = { duration: reducedMotionRef.current ? 0 : 250 };
    if (delta === 1) map.zoomIn(options);
    else map.zoomOut(options);
  }, []);

  const coordinate = formatCoordinate(latitude, longitude);

  return (
    <div className="space-y-2">
      <div className="relative">
        <div
          ref={containerRef}
          role="region"
          aria-label={`Map showing ${label}. The coordinate is written out in full below this map, which is the equivalent surface.`}
          className="h-[22rem] w-full overflow-hidden rounded-lg border border-border bg-muted"
        />

        {basemapFailed ? (
          <p
            role="status"
            className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              The background map didn&rsquo;t load, so there is no coastline or place name here.
              The coordinate below is unaffected.
            </span>
          </p>
        ) : null}

        <div className="absolute bottom-12 right-3 flex flex-col gap-1">
          <MapButton label="Zoom in" onClick={() => zoomBy(1)}>
            <Plus className="size-4" aria-hidden="true" />
          </MapButton>
          <MapButton label="Zoom out" onClick={() => zoomBy(-1)}>
            <Minus className="size-4" aria-hidden="true" />
          </MapButton>
        </div>

        {/* Attribution on the map itself (required by the tile and OSM data licences). */}
        <p className="absolute inset-x-0 bottom-0 rounded-b-lg bg-background/85 px-2 py-1 text-right text-[0.6875rem] leading-4 text-foreground-secondary">
          <a
            href={mapTiles.attributionUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {mapTiles.attribution}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </div>

      {/* The answer, in text, whether or not a single tile ever arrives. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Marked at <span className="font-mono text-foreground">{coordinate}</span>
        {accuracyMetres !== undefined && accuracyMetres > 1 ? (
          <>
            , inside a ring {Math.round(accuracyMetres)} m in radius — the area the input
            actually names
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

/** Our own zoom buttons: MapLibre's are 29px, below the 44px touch-target minimum. */
function MapButton({
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
        "motion-reduce:transition-none",
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}
