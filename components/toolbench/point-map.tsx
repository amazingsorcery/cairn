"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/*
 * NAMED IMPORTS, not a default. `maplibre-gl@6` ships an ESM build with no default export;
 * `import maplibregl from "maplibre-gl"` typechecks under some bundler settings and is
 * `undefined` at runtime under others.
 */
import { GeoJSONSource, Map as MapLibreMap, Marker, setWorkerUrl } from "maplibre-gl";
import { Minus, Plus, TriangleAlert } from "lucide-react";

import { mapTiles } from "@/config/live";
import { cn } from "@/lib/utils";

/**
 * A single-point map preview for the coordinate converter and the GPS fix in the image
 * metadata inspector.
 *
 * ── WHY THIS IS MAPLIBRE AND NO LONGER LEAFLET ─────────────────────────────
 * It was Leaflet, pointed at `mapTiles.urlTemplate` — a raster `{z}/{x}/{y}` template. When
 * the tile provider moved to OpenFreeMap that field kept its name but stopped being a raster
 * template, so Leaflet requested the same style JSON for every tile and drew nothing: a map
 * that compiled, ran, threw no error and rendered an empty grey box. `config/live.ts` now
 * exposes `styleUrl` and no `urlTemplate`, which turns that class of mistake into a type
 * error. OpenFreeMap is vector-only and publishes no raster endpoint, so the consumer has to
 * be a vector renderer. See `docs/frontend/HANDOFF-basemaps.md`.
 *
 * The CSP objection that originally chose Leaflet (`HANDOFF-toolbench.md` §4.1: MapLibre
 * fetches tiles over XHR and needs `connect-src` widened) has since been answered elsewhere —
 * the Live Map runs on MapLibre, so the generated policy already carries `connect-src` and
 * `img-src` for the tile origin plus `worker-src blob:`. This costs no new policy.
 *
 * ── FIVE THINGS HERE ARE LOAD-BEARING ──────────────────────────────────────
 *
 * 1. **It is only ever reached through `next/dynamic(..., { ssr: false })`, after a click.**
 *    MapLibre is the largest dependency in the product; no route that does not draw a map may
 *    pay for it. And the privacy argument is sharper on this tool than anywhere else: a tile
 *    request tells the tile host which coordinate a reader is looking at, and on a coordinate
 *    tool that coordinate *is* the investigation. The click gate is in `map-preview.tsx`.
 *
 * 2. **The worker URL is set at module scope.** `maplibre-gl@6` locates its worker with a
 *    dynamic `new URL(...)` that webpack never emits, so it asks for a chunk that does not
 *    exist and — because vector tiles are parsed IN the worker — never issues a single tile
 *    request. No error, no failed image: a black rectangle with a correct marker on it, which
 *    reads as a styling bug and is not one. `scripts/copy-maplibre-assets.ts` copies the
 *    files into `public/maplibre/` at `prebuild`; this points at them, before the first
 *    `new MapLibreMap`, because MapLibre reads the value when it builds its worker pool.
 *
 * 3. **No marker image is ever requested.** The pin is an inline SVG built with
 *    `createElementNS`, and the accuracy ring is a GeoJSON polygon drawn by the style. The
 *    deployed CSP (`infra/csp.caddy`, ADR 0017) allows `'self'`, `data:`, `blob:` and named
 *    hosts; a default marker URL works in development and is blocked in production.
 *
 * 4. **The tile style comes from `config/live.ts` and nowhere else.** That file is the single
 *    declaration `scripts/generate-csp.ts` reads. A hardcoded URL here produces a map that
 *    works locally and is blocked in production.
 *
 * 5. **The coordinate is written out under the map, always.** The number is the answer and
 *    the map is the illustration, so a dead tile host costs the reader the illustration and
 *    nothing else.
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
 * The accuracy ring, as a polygon.
 *
 * MapLibre's `circle` layer measures its radius in screen pixels, which would grow and shrink
 * against the ground as the reader zooms — the opposite of what "this coordinate names an area
 * 60 m across" means. A polygon is in world coordinates, so it stays the size of the thing it
 * describes.
 *
 * Equirectangular, not geodesic: at the radii this tool deals in (metres to a few kilometres)
 * the difference is far below the width of the line, and a geodesic ring would be precision
 * the input does not have.
 */
function accuracyRing(
  latitude: number,
  longitude: number,
  radiusMetres: number,
): GeoJSON.FeatureCollection {
  const steps = 64;
  const dLat = radiusMetres / METRES_PER_DEGREE;
  /* Guard the pole: `cos(90°)` is zero and would send the longitude offset to infinity. */
  const cosLat = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  const dLon = radiusMetres / (METRES_PER_DEGREE * cosLat);

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
 * The marker, built as DOM rather than as JSX.
 *
 * MapLibre moves a marker's element into its own container, which is why this is not a React
 * node: React would later try to remove a child from a parent that is no longer its parent.
 * Built with `createElementNS` rather than `innerHTML` so there is no HTML string to escape
 * and nothing for a sanitiser rule to argue with.
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
  /*
   * The basemap and the coordinate are separable failures. A dead tile host costs the reader
   * the background and nothing else — the coordinate is stated in text below and is unaffected
   * — but it must not fail silently, because a blank rectangle reads as a styling bug.
   */
  const [basemapFailed, setBasemapFailed] = React.useState(false);

  /* Motion is a vestibular trigger, not a decoration, and a map is a large moving surface. */
  const reducedMotionRef = React.useRef(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedMotionRef.current = reducedMotion;

    const map = new MapLibreMap({
      container,
      style: mapTiles.styleUrl,
      center: [longitude, latitude],
      zoom,
      /* Our own controls: MapLibre's are 29px and the floor here is 44 (HANDOFF-shell §10.4). */
      attributionControl: false,
      /*
       * Rotation and pitch are two-finger gestures with no single-finger equivalent, and a
       * rotated north is a map an investigator can misread. Drag pans, the buttons zoom.
       */
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      /* Arrow keys pan and +/- zoom once the canvas has focus. */
      keyboard: true,
      fadeDuration: reducedMotion ? 0 : 300,
    });

    map.touchZoomRotate.disableRotation();

    /*
     * MapLibre reports style, worker and tile failures through `error` rather than by throwing,
     * so without this handler they are swallowed and the map simply stays blank.
     */
    map.on("error", () => setBasemapFailed(true));

    map.on("load", () => {
      map.addSource(ACCURACY_SOURCE, { type: "geojson", data: NO_RING });
      map.addLayer({
        id: ACCURACY_FILL,
        type: "fill",
        source: ACCURACY_SOURCE,
        paint: { "fill-color": "#38bdf8", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: ACCURACY_LINE,
        type: "line",
        source: ACCURACY_SOURCE,
        paint: { "line-color": "#38bdf8", "line-width": 1 },
      });
      setReady(true);
    });

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
    /*
     * The centre and zoom seed the initial view only; the guard at the top makes a re-run a
     * no-op, so these can stay in the dependency list honestly rather than being suppressed.
     * Once the map exists the reader owns the viewport, and the effect below moves the marker
     * without tearing the map down.
     */
  }, [latitude, longitude, zoom]);

  /** Move the marker and re-centre as the coordinate changes, without rebuilding the map. */
  React.useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;

    marker.setLngLat([longitude, latitude]);
    /* `easeTo` with a zero duration, never `flyTo`: no zoom-out-and-back swoop, ever. */
    map.easeTo({ center: [longitude, latitude], duration: reducedMotionRef.current ? 0 : 400 });
  }, [latitude, longitude]);

  /** The accuracy ring follows the coordinate, and disappears when there is no stated area. */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(ACCURACY_SOURCE);
    if (!(source instanceof GeoJSONSource)) return;
    source.setData(
      accuracyMetres !== undefined && accuracyMetres > 1
        ? accuracyRing(latitude, longitude, accuracyMetres)
        : NO_RING,
    );
  }, [latitude, longitude, accuracyMetres, ready]);

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

        {/*
          ATTRIBUTION, ON THE MAP. Not in a page footer, not behind an "i" button: it is a
          condition of use for both the tiles and the OpenStreetMap data underneath them, so a
          missing credit is a licence breach and not a polish defect.
        */}
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

/**
 * Our own zoom controls rather than MapLibre's, for one reason: MapLibre's are 29px and the
 * accessibility floor in this product is 44 (`HANDOFF-shell.md` §10.4).
 */
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
