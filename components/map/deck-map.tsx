"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as React from "react";
/* Named imports: `maplibre-gl@6` ESM has no default export (undefined at runtime). */
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
 * The WebGL leaf: MapLibre GL for the basemap, deck.gl for data layers.
 *
 * Only loaded via dynamic import after the reader opts in, both for bundle size and because
 * WebGL is a fingerprinting surface and the tile server sees the viewport.
 *
 * Layer-agnostic: it calls `definition.deck(kit, input)`. The constructors below are the only
 * runtime import of `@deck.gl/layers`; a new geometry kind needs adding here.
 */

/** The constructors handed to every layer factory. See `registry/types.ts`. */
const DECK_KIT: DeckKit = { ScatterplotLayer, IconLayer, PathLayer };

/**
 * MapLibre resolves its worker via a dynamic `new URL(..., import.meta.url)`, which webpack
 * doesn't emit. Without a worker no tiles are requested and the basemap is silently blank.
 * `scripts/copy-maplibre-assets.ts` copies the worker and `maplibre-gl-shared.mjs` (which
 * the worker imports) into `public/maplibre/` on prebuild.
 *
 * Module scope because it must be set before the first `new MapLibreMap`.
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
  /** Fired on `moveend` (not per frame) so viewport-scoped layers can refetch. */
  onViewportChange?: (viewport: MapViewport) => void;
  /** Accessible name for the map region; should point to the tables below. */
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
   * Basemap failures are shown separately; deck.gl still draws the features on its own
   * canvas, but a silently blank background would look like a styling bug.
   */
  const [basemapFailed, setBasemapFailed] = React.useState(false);

  /* Callbacks in refs so changing them doesn't rebuild the map and lose pan/zoom. */
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
      /* Our own controls; MapLibre's are 29px and we need 44px touch targets. */
      attributionControl: false,
      /* No rotation or pitch: they're two-finger only and a rotated north is easy to misread. */
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      /* Arrow keys pan and +/- zoom once the canvas has focus. */
      keyboard: true,
      /* Reduced motion: no tile cross-fade (zoom buttons also use duration 0, no `flyTo`). */
      fadeDuration: reducedMotion ? 0 : 300,
      trackResize: true,
    });

    map.touchZoomRotate.disableRotation();

    /*
     * MapboxOverlay is typed against mapbox-gl's `IControl`, structurally identical to
     * MapLibre's; casting to MapLibre's interface is the documented approach.
     */
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      /* Makes small dots hittable on touch (~24px effective target). */
      pickingRadius: 10,
      getCursor: ({ isDragging, isHovering }) =>
        isDragging ? "grabbing" : isHovering ? "pointer" : "grab",
    });
    map.addControl(overlay as unknown as IControl);

    /* Clicking empty basemap clears the selection. */
    map.on("click", (event: MapMouseEvent) => {
      const picked = overlay.pickObject({ x: event.point.x, y: event.point.y, radius: 10 });
      if (!picked) onSelectRef.current(null);
    });

    map.once("load", () => {
      setReady(true);
      if (process.env.NODE_ENV !== "production") warnOnUndeclaredAttribution(map);
    });

    /* MapLibre reports style/worker/tile failures via `error` rather than throwing. */
    map.on("error", () => setBasemapFailed(true));

    /* `moveend`, not `move`: only query sources once panning stops. */
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
    // Run once: these props only seed the map; later changes are applied by the effects below.
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

      {/* Bottom right, above the attribution bar; 44px buttons. */}
      <div className="absolute bottom-12 right-3 flex flex-col gap-1">
        <MapButton label="Zoom in" onClick={() => zoomBy(1)}>
          <Plus className="size-4" aria-hidden="true" />
        </MapButton>
        <MapButton label="Zoom out" onClick={() => zoomBy(-1)}>
          <Minus className="size-4" aria-hidden="true" />
        </MapButton>
      </div>

      {/* Attribution on the map itself (licence requirement), declared in `basemap.ts`. */}
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
 * Dev-only: warn if the style declares an attribution that `basemap.ts` doesn't render
 * (credits there are hand-maintained).
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
