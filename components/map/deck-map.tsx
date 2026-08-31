"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/*
 * NAMED IMPORTS, not a default. `maplibre-gl@6` ships an ESM build with no default export;
 * `import maplibregl from "maplibre-gl"` typechecks under some bundler settings and is
 * `undefined` at runtime under others.
 */
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import type { IControl, MapMouseEvent, StyleSpecification } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Minus, Plus, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceFeature } from "@/lib/sources/types";
import { basemap, basemapStyleUrl } from "./basemap";
import type { DeckKit, MapLayerDefinition, MapViewport } from "./registry";
import { SELECTION_RING, layerColour } from "./registry/palette";

/**
 * The WebGL leaf. MapLibre GL for the basemap, deck.gl for every data layer.
 *
 * ## It is only ever reached through a dynamic import, after the reader opts in
 *
 * `map-surface.tsx` does `await import("./deck-map")` behind a control. Two reasons, and
 * only one of them is bundle size:
 *
 * 1. MapLibre and deck.gl are the largest dependencies in the product by a wide margin. No
 *    other route may pay for them, and this route must not pay for them until asked.
 * 2. **WebGL is a fingerprinting surface** — renderer strings, extension lists, precision
 *    quirks — and a tile server sees the viewport the reader is looking at. ADR 0019 records
 *    that this cost is accepted because the brief locks deck.gl, on the explicit condition
 *    that the map stays opt-out and the table path stays complete. This file existing behind
 *    a click is that condition, implemented.
 *
 * ## It knows about no layer in particular
 *
 * It is handed `MapLayerDefinition`s and calls `definition.deck(kit, input)`. The three
 * deck.gl constructors below are the only runtime import of `@deck.gl/layers` in the
 * codebase; the registry holds type-only references, which TypeScript erases. Adding a
 * source does not touch this file — adding a new *kind of geometry* does, and that is the
 * intended friction: each constructor lands in this chunk whether a layer uses it or not.
 */

/** The constructors handed to every layer factory. See `registry/types.ts`. */
const DECK_KIT: DeckKit = { ScatterplotLayer, IconLayer, PathLayer };

/**
 * WHERE MAPLIBRE FINDS ITS WORKER, and why it has to be told.
 *
 * `maplibre-gl@6` locates the worker with `new URL("./maplibre-gl-worker.mjs",
 * import.meta.url)`. That template is dynamic, so webpack never emits the file, and
 * `import.meta.url` points at a Next chunk directory where it does not exist. MapLibre then
 * asks for a chunk that was never built, gets Next's HTML 404 back, and the browser rejects
 * it for its MIME type.
 *
 * The symptom is the reason this is worth a paragraph: MapLibre parses vector tiles IN the
 * worker, so with no worker it never requests a tile at all. No error on the map, no failed
 * image, no exception — a black rectangle with deck.gl's dots drawn correctly on top of it,
 * which looks like a styling mistake. `scripts/copy-maplibre-assets.ts` copies the two files
 * into `public/maplibre/` on `prebuild`, and this points at them. Both are needed: the worker
 * imports `./maplibre-gl-shared.mjs` relative to its own URL, so a worker served without its
 * sibling 404s on its first statement and fails exactly as silently as the original bug.
 *
 * It must run before the first `new MapLibreMap`, so it is module scope rather than an
 * effect: MapLibre reads the value when it builds its worker pool.
 */
/*
 * Served from `public/`, copied there by `scripts/copy-maplibre-assets.ts` in `prebuild`.
 *
 * It was previously a route handler that `readFileSync`d out of `node_modules`. That worked
 * in development and would have 404'd in the container: Next's output tracer cannot see a
 * computed path, and maplibre is imported only from `"use client"` modules, so nothing pulls
 * it into the standalone bundle. Same shape as the pdfkit AFM problem — a green build and a
 * broken deploy, found by the devops engineer reading the trace rather than by anything
 * failing.
 */
const WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
setWorkerUrl(WORKER_URL);

export interface DeckMapLayerInput {
  definition: MapLayerDefinition;
  features: readonly SourceFeature[];
}

export interface DeckMapProps {
  layers: readonly DeckMapLayerInput[];
  selectedId: string | null;
  onSelect: (featureId: string | null) => void;
  theme: "dark" | "light";
  reducedMotion: boolean;
  initialView: { longitude: number; latitude: number; zoom: number };
  /**
   * Fired after the reader stops panning, so a viewport-scoped layer can ask its source for
   * the patch of the world now on screen. Fired on `moveend` rather than on every frame:
   * a source call per animation frame would breach any fair-use policy in seconds.
   */
  onViewportChange?: (viewport: MapViewport) => void;
  /**
   * Accessible name for the map region. It must say that the tables below carry the same
   * data, because for a screen-reader user this canvas is an empty box.
   */
  label: string;
}

export default function DeckMap({
  layers,
  selectedId,
  onSelect,
  theme,
  reducedMotion,
  initialView,
  onViewportChange,
  label,
}: DeckMapProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<MapLibreMap | null>(null);
  const overlayRef = React.useRef<MapboxOverlay | null>(null);
  const [ready, setReady] = React.useState(false);
  /*
   * The basemap and the data are separable failures, and they degrade separately. deck.gl
   * draws the features on its own canvas, so a dead tile server costs the reader the
   * background and nothing else — the points are still in the right places and the tables
   * below are untouched. What it must not do is fail silently: a black rectangle reads as a
   * styling bug, and a reader would not know the geography under the dots was missing.
   */
  const [basemapFailed, setBasemapFailed] = React.useState(false);

  /*
   * Callbacks live in refs so that changing one does not tear the map down and rebuild it.
   * A map that re-initialises when a parent re-renders loses the reader's pan and zoom, which
   * is the single most annoying bug a map can have.
   */
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const onViewportChangeRef = React.useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  /* ------------------------------------------------------------------ *
   * Create the map. Once.
   * ------------------------------------------------------------------ */
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = new MapLibreMap({
      container,
      style: basemapStyleUrl(theme),
      center: [initialView.longitude, initialView.latitude],
      zoom: initialView.zoom,
      maxZoom: basemap.maxZoom,
      /* Our own controls; MapLibre's are 29px and the floor here is 44 (HANDOFF-shell §10.4). */
      attributionControl: false,
      /*
       * ONE-FINGER OPERATION. Rotation and pitch are two-finger gestures with no single-finger
       * equivalent and no value on a data map — a rotated north is a map an investigator can
       * misread. Turning them off removes the only gestures that had no one-finger fallback,
       * and leaves drag to pan (one finger) and the buttons below to zoom (one finger).
       */
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      /* Arrow keys pan and +/- zoom once the canvas has focus. */
      keyboard: true,
      /*
       * `prefers-reduced-motion`. A map is one of the largest moving surfaces a reader meets,
       * and motion is a vestibular trigger rather than a decoration. `fadeDuration: 0` stops
       * the cross-fade as tiles arrive; the zoom buttons below pass `duration: 0` for the
       * same reason; and nothing in this component ever calls `flyTo`.
       */
      fadeDuration: reducedMotion ? 0 : 300,
      /* Same payload for every viewer; MapLibre must not add a cookie or a session id. */
      trackResize: true,
    });

    map.touchZoomRotate.disableRotation();

    /*
     * MapboxOverlay is deck.gl's MapLibre/Mapbox integration and declares itself against the
     * mapbox-gl `IControl`, which is structurally the same as MapLibre's but nominally a
     * different type. The cast is to MapLibre's own interface — not to `any` — and is the
     * documented way to use the two together.
     */
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      /*
       * Touch targets. deck.gl picks the exact pixel under the pointer by default, which on a
       * phone means a 4px dot is unhittable. 10px of picking radius makes the effective target
       * around 24px across for the smallest dot and larger for everything else.
       */
      pickingRadius: 10,
      getCursor: ({ isDragging, isHovering }) =>
        isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
    });
    map.addControl(overlay as unknown as IControl);

    /*
     * A click on the basemap, not on a feature, clears the selection. Without it the only way
     * to close a feature is the panel's own button, and a reader who opened one by accident
     * has to hunt for the way out.
     */
    map.on("click", (event: MapMouseEvent) => {
      const picked = overlay.pickObject({ x: event.point.x, y: event.point.y, radius: 10 });
      if (!picked) onSelectRef.current(null);
    });

    map.once("load", () => {
      setReady(true);
      if (process.env.NODE_ENV !== "production") warnOnUndeclaredAttribution(map);
    });

    /*
     * MapLibre reports style, worker and tile failures through `error` rather than by
     * throwing, so without this handler they are swallowed and the map just stays blank.
     */
    map.on("error", () => setBasemapFailed(true));

    /*
     * `moveend`, not `move`. The reader owns the viewport; we ask a source about it once they
     * have stopped, and never while they are still moving.
     */
    map.on("moveend", () => {
      const bounds = map.getBounds();
      onViewportChangeRef.current?.({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      });
    });

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      overlay.finalize();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    /*
     * Deliberately empty. The theme, the initial view and the reduced-motion flag seed the
     * map and are then owned by the reader or applied by the effects below. Re-running this
     * would destroy and rebuild the map under someone's hand.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ *
   * Theme changes swap the style, keeping the reader's viewport.
   * ------------------------------------------------------------------ */
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setStyle(basemapStyleUrl(theme));
  }, [theme, ready]);

  /* ------------------------------------------------------------------ *
   * Layers. The registry builds them; this component builds none.
   * ------------------------------------------------------------------ */
  React.useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const built: Layer[] = [];
    for (const { definition, features } of layers) {
      const colour = layerColour(definition.colour, theme);
      const result = definition.deck(DECK_KIT, {
        id: `layer-${definition.id}`,
        features,
        selectedId,
        colour,
        selectedColour: theme === "dark" ? SELECTION_RING.dark : SELECTION_RING.light,
        reducedMotion,
        onSelect: (featureId) => onSelectRef.current(featureId),
      });
      if (Array.isArray(result)) built.push(...result);
      else built.push(result as Layer);
    }

    overlay.setProps({ layers: built });
  }, [layers, selectedId, theme, reducedMotion]);

  const zoomBy = React.useCallback(
    (delta: 1 | -1) => {
      const map = mapRef.current;
      if (!map) return;
      const options = { duration: reducedMotion ? 0 : 250 };
      if (delta === 1) map.zoomIn(options);
      else map.zoomOut(options);
    },
    [reducedMotion],
  );

  return (
    <div className="relative">
      <div
        ref={containerRef}
        role="region"
        aria-label={label}
        className="h-[55vh] min-h-[18rem] w-full overflow-hidden rounded-lg border border-border bg-muted md:h-[65vh]"
      />

      {basemapFailed ? (
        <p
          role="status"
          className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            The background map didn&rsquo;t load, so there is no coastline or place name under
            these features. Their positions are unaffected, and the tables below list every one
            of them.
          </span>
        </p>
      ) : null}

      {/*
        Bottom right, inside thumb reach on a phone held in either hand, and clear of the
        attribution bar. 44px each, which is the accessibility floor and also the smallest
        button that can be hit while walking.
      */}
      <div className="absolute bottom-12 right-3 flex flex-col gap-1">
        <MapButton label="Zoom in" onClick={() => zoomBy(1)}>
          <Plus className="size-4" aria-hidden="true" />
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomBy(-1)}>
          <Minus className="size-4" aria-hidden="true" />
        </MapButton>
      </div>

      {/*
        ATTRIBUTION, ON THE MAP. Not in a page footer, not behind an "i" button. It is a
        condition of use for both the tiles and the underlying OpenStreetMap data, and it is
        declared once in `basemap.ts` so no component can forget a line of it.
      */}
      <p className="absolute inset-x-0 bottom-0 flex flex-wrap justify-end gap-x-2 rounded-b-lg bg-background/85 px-2 py-1 text-[0.6875rem] leading-4 text-foreground-secondary">
        {basemap.attribution.map((credit) => (
          <a
            key={credit.text}
            href={credit.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {credit.text}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ))}
      </p>
    </div>
  );
}

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

/**
 * Development-only guard against an attribution we are not rendering.
 *
 * `basemap.ts` declares the credits by hand, because a hand-declared credit is one a human
 * checked against the licence. The risk of hand-declaring is that the provider changes its
 * style file and adds a credit we never learn about — and a missing credit is a licence
 * breach, not a polish defect. This compares the style's own declared attribution against
 * ours and says so in the console during development. It is not a production check: it must
 * never be the thing that decides what a reader sees.
 */
function warnOnUndeclaredAttribution(map: MapLibreMap): void {
  const style: StyleSpecification = map.getStyle();
  const declared = basemap.attribution.map((a) => a.text.toLowerCase()).join(" ");
  for (const source of Object.values(style.sources ?? {})) {
    const attribution = "attribution" in source ? source.attribution : undefined;
    if (typeof attribution !== "string") continue;
    for (const word of attribution.replace(/<[^>]*>/g, " ").split(/[·,|]/)) {
      const trimmed = word.trim();
      if (trimmed.length > 3 && !declared.includes(trimmed.toLowerCase())) {
        console.warn(
          `[map] The basemap style declares an attribution this build does not render: "${trimmed}". ` +
            `Add it to components/map/basemap.ts — a missing credit is a licence breach.`,
        );
      }
    }
  }
}
