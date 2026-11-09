"use client";

import * as React from "react";
import { Map as MapIcon, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ageSeconds, formatAge, formatClockUtc, formatNumber } from "@/components/live/live-format";
import { cn } from "@/lib/utils";
import type { SourceFeature } from "@/lib/sources/types";
import { basemap } from "./basemap";
import type { DeckMapProps } from "./deck-map";
import { FeatureDetail } from "./feature-detail";
import { FeatureTable } from "./feature-table";
import { LayerControls } from "./layer-controls";
import { LayerStatus, formatCheckedDate } from "./layer-status";
import { parseLayerPayload } from "./payload";
import { sourceQueryKey } from "./query";
import {
  TICK_MS,
  VIEWPORT_SETTLE_MS,
  createSettler,
  refreshReason,
  viewportGapMs,
  type Settler,
} from "./refresh-policy";
import {
  MAP_LAYERS,
  findLayer,
  layerQuery,
  type LayerPayloadDto,
  type MapLayerDefinition,
  type MapViewport,
  type TableSort,
} from "./registry";
import { sortDescription } from "./sort";
import { useReducedMotion, useResolvedTheme } from "./use-map-environment";

/**
 * Client leaf for the map route; the page (a Server Component) fetches, so every table is in
 * the initial HTML.
 *
 * Layer-agnostic: everything comes from `MAP_LAYERS` (`registry.test.ts` checks no layer is
 * named here). Controls, map, tables and detail share one state so counts and ages agree.
 *
 * The map is opt-in (WebGL fingerprinting, tile server sees the viewport); the tables always
 * render.
 */

type MapState = "closed" | "loading" | "ready" | "failed";

/**
 * The viewport before the reader has moved anything, matching what the server fetched for.
 * ±85° rather than ±90 because Web Mercator does not reach the poles.
 */
const WORLD: MapViewport = { west: -180, south: -85, east: 180, north: 85 };

/**
 * The server's cache key for one layer at one viewport. Lets the client tell whether a pan
 * asks anything new, using the same normalisation as the server.
 */
function queryKeyFor(layer: MapLayerDefinition, viewport: MapViewport): string {
  return sourceQueryKey(layerQuery(layer, viewport));
}

export interface MapSurfaceProps {
  /** One entry per layer in the registry, fetched on the server. */
  initialPayloads: Readonly<Record<string, LayerPayloadDto>>;
  /** Age in whole seconds at server render time, per layer. Keeps hydration honest. */
  initialAges: Readonly<Record<string, number | null>>;
  /** Layer ids visible on first paint, from the registry's own defaults. */
  initialVisible: readonly string[];
  initialView: { longitude: number; latitude: number; zoom: number };
  /**
   * Whether this deployment has case workspaces. From the server env; in public-only mode
   * `/map/save` 404s, so the save control is hidden.
   */
  signInEnabled: boolean;
}

export function MapSurface({
  initialPayloads,
  initialAges,
  initialVisible,
  initialView,
  signInEnabled,
}: MapSurfaceProps) {
  const theme = useResolvedTheme();
  const reducedMotion = useReducedMotion();

  const [payloads, setPayloads] = React.useState(initialPayloads);
  const [visible, setVisible] = React.useState<ReadonlySet<string>>(() => new Set(initialVisible));
  const [sorts, setSorts] = React.useState<Readonly<Record<string, TableSort>>>(() =>
    Object.fromEntries(MAP_LAYERS.map((layer) => [layer.id, layer.defaultSort])),
  );
  const [selected, setSelected] = React.useState<{ layerId: string; featureId: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = React.useState<ReadonlySet<string>>(() => new Set());
  /*
   * Current viewport; the world (what the server fetched) until the reader pans. State
   * because the "different area" note renders from it; the settler limits updates to once
   * per gesture.
   */
  const [viewport, setViewport] = React.useState<MapViewport>(WORLD);
  /* The same value, readable synchronously by a fetch that a timer started. */
  const viewportRef = React.useRef<MapViewport>(WORLD);
  /* Where the last `moveend` left the map, before the settler has accepted it. */
  const pendingViewportRef = React.useRef<MapViewport | null>(null);
  /*
   * The cache key each layer's current payload answers. Comparing keys rather than positions
   * lets the throttle skip pans that don't change the query.
   */
  const [answeredKeys, setAnsweredKeys] = React.useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(MAP_LAYERS.map((layer) => [layer.id, queryKeyFor(layer, WORLD)])),
  );
  /** When we last sent a request per layer, whatever came back. Paces every automatic path. */
  const requestedAtRef = React.useRef<Record<string, number>>({});
  /*
   * The server render counts as a request for pacing, so a failed layer isn't re-requested
   * on the first tick. Dated from the observation (mount minus `initialAges`), not mount,
   * since the server may have served a cache entry that's nearly expired.
   */
  const mountedAtRef = React.useRef<number>(Date.now());
  const initialRequestedAt = React.useCallback(
    (layerId: string): number => mountedAtRef.current - (initialAges[layerId] ?? 0) * 1000,
    [initialAges],
  );
  const [mapState, setMapState] = React.useState<MapState>("closed");
  const [MapComponent, setMapComponent] =
    React.useState<React.ComponentType<DeckMapProps> | null>(null);

  /* The element that opened the detail panel, so Escape and close return focus to it. */
  const detailTriggerRef = React.useRef<HTMLElement | null>(null);

  /* ------------------------------------------------------------------ *
   * Refresh — one layer at a time, through our own server
   * ------------------------------------------------------------------ */

  const refreshLayer = React.useCallback(async (layerId: string) => {
    setRefreshing((current) => new Set(current).add(layerId));
    requestedAtRef.current[layerId] = Date.now();
    try {
      /*
       * The viewport is sent with every refresh; the server quantises it to a whole-degree
       * grid so nearby readers share a cache entry and upstreams see a coarser coordinate.
       */
      const view = viewportRef.current;
      const layer = findLayer(layerId);
      /* The question this request asks, in the server's own key space. */
      const requestedKey = layer ? queryKeyFor(layer, view) : null;
      const query = new URLSearchParams({
        w: view.west.toFixed(3),
        s: view.south.toFixed(3),
        e: view.east.toFixed(3),
        n: view.north.toFixed(3),
      });
      const response = await fetch(`/map/data/${encodeURIComponent(layerId)}?${query}`, {
        cache: "no-store",
      });
      const body: unknown = await response.json();
      const parsed = parseLayerPayload(body, layerId);
      setPayloads((current) => ({ ...current, [layerId]: parsed }));
      // Record the key for any completed response (success or failure), not for a thrown fetch.
      if (requestedKey !== null) {
        setAnsweredKeys((current) => ({ ...current, [layerId]: requestedKey }));
      }
    } catch {
      // A failed refresh changes nothing; the existing payload's age keeps counting up.
    } finally {
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(layerId);
        return next;
      });
    }
  }, []);

  /**
   * The single place automatic requests are decided (expiry, failure recovery, viewport),
   * via the pure `refreshReason` in `refresh-policy.ts`. Hidden layers are skipped; hidden
   * tabs are skipped by the timer.
   */
  const evaluate = React.useCallback(
    (now: number) => {
      for (const layer of MAP_LAYERS) {
        if (!visible.has(layer.id)) continue;
        const reason = refreshReason({
          payload: payloads[layer.id],
          wantedKey: queryKeyFor(layer, viewportRef.current),
          heldKey: answeredKeys[layer.id] ?? null,
          lastRequestedAt: requestedAtRef.current[layer.id] ?? initialRequestedAt(layer.id),
          now,
        });
        if (reason !== null) void refreshLayer(layer.id);
      }
    },
    [visible, payloads, answeredKeys, refreshLayer, initialRequestedAt],
  );

  /* Read through a ref by the interval, so a new payload does not restart the clock. */
  const evaluateRef = React.useRef(evaluate);
  evaluateRef.current = evaluate;

  /*
   * One heartbeat timer for all layers; the actual cadence is each source's TTL. A pan that
   * arrives inside the minimum gap is picked up by a later tick rather than dropped.
   */
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      evaluateRef.current(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /* Evaluate immediately when the viewport settles. */
  React.useEffect(() => {
    evaluateRef.current(Date.now());
  }, [viewport]);

  /* ------------------------------------------------------------------ *
   * The map — loaded on request, never on page load
   * ------------------------------------------------------------------ */

  const openMap = React.useCallback(async () => {
    setMapState("loading");
    try {
      // Not named `module`: Next forbids assigning that identifier during bundling
      // (@next/next/no-assign-module-variable).
      const mapModule = await import("./deck-map");
      setMapComponent(() => mapModule.default);
      setMapState("ready");
    } catch {
      /* The tables are the primary surface and are untouched by this. */
      setMapState("failed");
    }
  }, []);

  /**
   * Pans only record the viewport; nothing is fetched here. The settler collapses a drag's
   * `moveend`s into one update, and the policy decides per layer whether to fetch. Fetching
   * per `moveend` would burn through upstream limits (adsb.lol's ceiling is 6 calls/minute).
   */
  const settleViewport = React.useCallback(() => {
    const next = pendingViewportRef.current;
    if (!next) return;
    viewportRef.current = next;
    setViewport(next);
  }, []);

  const settleRef = React.useRef(settleViewport);
  settleRef.current = settleViewport;
  const settlerRef = React.useRef<Settler | null>(null);
  settlerRef.current ??= createSettler(VIEWPORT_SETTLE_MS, () => settleRef.current());
  React.useEffect(() => () => settlerRef.current?.cancel(), []);

  const handleViewportChange = React.useCallback((next: MapViewport) => {
    pendingViewportRef.current = next;
    settlerRef.current?.notify();
  }, []);

  /* ------------------------------------------------------------------ *
   * Selection
   * ------------------------------------------------------------------ */

  const selectFeature = React.useCallback((layerId: string, featureId: string | null) => {
    if (featureId === null) {
      setSelected(null);
      return;
    }
    const active = document.activeElement;
    detailTriggerRef.current = active instanceof HTMLElement ? active : null;
    setSelected((current) =>
      current?.layerId === layerId && current.featureId === featureId
        ? null
        : { layerId, featureId },
    );
  }, []);

  const closeDetail = React.useCallback(() => {
    setSelected(null);
    /* Return focus to whatever opened the panel. */
    const trigger = detailTriggerRef.current;
    if (trigger && document.contains(trigger)) trigger.focus();
  }, []);

  /* ------------------------------------------------------------------ *
   * Derived
   * ------------------------------------------------------------------ */

  const visibleLayers = React.useMemo(
    () => MAP_LAYERS.filter((layer) => visible.has(layer.id)),
    [visible],
  );

  /** What the WebGL leaf draws. Only layers that are both switched on and have data. */
  const deckLayers = React.useMemo(
    () =>
      visibleLayers.flatMap((definition) => {
        const payload = payloads[definition.id];
        if (!payload?.ok) return [];
        return [{ definition, features: payload.features }];
      }),
    [visibleLayers, payloads],
  );

  /**
   * Note shown while a throttled layer's payload answers a different area than the one on
   * screen, or null. Layers without a `query` never hit this.
   */
  const areaNoteFor = React.useCallback(
    (layer: MapLayerDefinition): string | null => {
      const payload = payloads[layer.id];
      if (!payload?.ok) return null;
      const answered = answeredKeys[layer.id];
      if (answered === undefined || answered === queryKeyFor(layer, viewport)) return null;
      const everySeconds = Math.round(viewportGapMs(payload.source.ttlSeconds) / 1000);
      return (
        `These features answer a different part of the map than the one now on screen. ` +
        `${payload.source.name} is asked at most once every ${everySeconds} seconds, so the ` +
        `list updates shortly.`
      );
    },
    [payloads, answeredKeys, viewport],
  );

  const selectedLayer = selected ? findLayer(selected.layerId) : null;
  const selectedPayload = selected ? payloads[selected.layerId] : undefined;
  const selectedFeature =
    selected && selectedPayload?.ok
      ? (selectedPayload.features.find((f) => f.id === selected.featureId) ?? null)
      : null;

  /**
   * A payload's age, deliberately not ticking: it uses the server's age for the initial
   * payload (avoids a hydration mismatch), and it feeds the live region, which would
   * otherwise announce every second. The status rows have the ticking age.
   */
  const ageAt = React.useCallback(
    (layerId: string, payload: Extract<LayerPayloadDto, { ok: true }>): number =>
      payload === initialPayloads[layerId]
        ? (initialAges[layerId] ?? 0)
        : ageSeconds(payload.observedAt),
    [initialPayloads, initialAges],
  );

  /** Text for the route's single polite live region: layers, counts, ages, sort order. */
  const announcement = visibleLayers
    .map((layer) => {
      const payload = payloads[layer.id];
      if (!payload) return `${layer.label}: not loaded.`;
      if (!payload.ok) return `${layer.unavailableTitle}.`;
      const sort = sorts[layer.id];
      /* Registries are announced by check date, not age (same wording as `layer-status.tsx`). */
      const freshness =
        layer.cadence === "registry"
          ? `checked ${formatCheckedDate(payload.observedAt)}`
          : formatAge(ageAt(layer.id, payload));
      /* Announced with the count, because it qualifies the count. */
      const areaNote = areaNoteFor(layer);
      return `${layer.label}: ${formatNumber(payload.features.length)} ${
        payload.features.length === 1 ? "feature" : "features"
      }, ${freshness}. ${areaNote ? `${areaNote} ` : ""}${sort ? sortDescription(layer, sort) : ""}`;
    })
    .join(" ");

  return (
    <div className="space-y-6">
      <p aria-live="polite" className="sr-only">
        {visibleLayers.length === 0 ? "No layers are switched on." : announcement}
      </p>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="order-1 min-w-0">
          {mapState === "closed" ? (
            <MapOptIn onOpen={() => void openMap()} />
          ) : mapState === "loading" ? (
            <div>
              <Skeleton className="h-[55vh] min-h-[18rem] w-full md:h-[65vh]" aria-hidden="true" />
              {/* A word, not a spinner. */}
              <p className="mt-2 text-sm text-foreground-secondary">Loading the map…</p>
            </div>
          ) : mapState === "failed" ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>The map didn&rsquo;t load</AlertTitle>
              <AlertDescription>
                The map code could not be fetched. Every layer below lists its features in a
                table and is unaffected.
                <span className="mt-3 block">
                  <Button variant="secondary" className="h-11" onClick={() => void openMap()}>
                    retry the map
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          ) : MapComponent ? (
            <MapComponent
              layers={deckLayers}
              selectedId={selected?.featureId ?? null}
              onSelect={(featureId) => {
                if (featureId === null) {
                  setSelected(null);
                  return;
                }
                const owner = deckLayers.find((entry) =>
                  entry.features.some((f) => f.id === featureId),
                );
                if (owner) selectFeature(owner.definition.id, featureId);
              }}
              theme={theme}
              reducedMotion={reducedMotion}
              initialView={initialView}
              onViewportChange={handleViewportChange}
              label={`Map of ${visibleLayers.map((l) => l.label.toLowerCase()).join(" and ")}. The tables below list the same features and are the equivalent surface.`}
            />
          ) : null}
        </div>

        {/* Under the map on phones, right rail from `md`. */}
        <LayerControls
          className="order-2 self-start"
          layers={MAP_LAYERS}
          payloads={payloads}
          visible={visible}
          theme={theme}
          onToggle={(layerId, next) =>
            setVisible((current) => {
              const updated = new Set(current);
              if (next) updated.add(layerId);
              else {
                updated.delete(layerId);
                /* Closing a layer closes a feature that belonged to it. */
                setSelected((sel) => (sel?.layerId === layerId ? null : sel));
              }
              return updated;
            })
          }
        />
      </div>

      {selectedLayer && selectedFeature && selectedPayload?.ok ? (
        <FeatureDetail
          layer={selectedLayer}
          feature={selectedFeature}
          payload={selectedPayload}
          onClose={closeDetail}
          signInEnabled={signInEnabled}
        />
      ) : null}

      {visibleLayers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">No layers are switched on</h2>
          <p className="mt-2 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
            Choose one in the layers panel. Each layer arrives with its source, the licence it
            is used under, and how old the data is.
          </p>
        </div>
      ) : null}

      {visibleLayers.map((layer) => (
        <LayerSection
          key={layer.id}
          layer={layer}
          payload={payloads[layer.id]}
          initialAgeSeconds={
            payloads[layer.id] === initialPayloads[layer.id] ? (initialAges[layer.id] ?? null) : null
          }
          refreshing={refreshing.has(layer.id)}
          areaNote={areaNoteFor(layer)}
          sort={sorts[layer.id] ?? layer.defaultSort}
          onSortChange={(sort) => setSorts((current) => ({ ...current, [layer.id]: sort }))}
          selectedId={selected?.layerId === layer.id ? selected.featureId : null}
          onSelect={(featureId) => selectFeature(layer.id, featureId)}
          onRetry={() => void refreshLayer(layer.id)}
        />
      ))}
    </div>
  );
}

/** One layer's section: status, source and table. */
function LayerSection({
  layer,
  payload,
  initialAgeSeconds,
  refreshing,
  areaNote,
  sort,
  onSortChange,
  selectedId,
  onSelect,
  onRetry,
}: {
  layer: MapLayerDefinition;
  payload: LayerPayloadDto | undefined;
  initialAgeSeconds: number | null;
  refreshing: boolean;
  /** Set while this layer's payload answers a different area than the map now shows. */
  areaNote: string | null;
  sort: TableSort;
  onSortChange: (sort: TableSort) => void;
  selectedId: string | null;
  onSelect: (featureId: string) => void;
  onRetry: () => void;
}) {
  const headingId = `map-layer-section-${layer.id}`;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-semibold tracking-tight">
        {layer.label}
      </h2>

      {payload ? (
        <LayerStatus
          label={layer.label}
          unavailableTitle={layer.unavailableTitle}
          payload={payload}
          /* Registry: check date; feed: age. */
          cadence={layer.cadence ?? "live"}
          refreshing={refreshing}
          initialAgeSeconds={initialAgeSeconds}
          onRetry={onRetry}
        />
      ) : null}

      {/* Shown visibly as well as in the table caption. */}
      {areaNote ? (
        <p className="max-w-[68ch] rounded-lg border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground-secondary">
          {areaNote}
        </p>
      ) : null}

      {payload?.ok ? (
        payload.features.length === 0 ? (
          <p className="max-w-[68ch] rounded-lg border border-border bg-card p-5 text-base leading-relaxed text-foreground-secondary">
            {layer.emptyMessage}
          </p>
        ) : (
          <FeatureTable<SourceFeature>
            layer={layer}
            features={payload.features}
            sort={sort}
            onSortChange={onSortChange}
            selectedId={selectedId}
            onSelect={onSelect}
            caption={`${layer.label}: ${formatNumber(payload.features.length)} ${
              payload.features.length === 1 ? "feature" : "features"
            } from ${payload.source.name}, ${
              layer.cadence === "registry"
                ? `checked ${formatCheckedDate(payload.observedAt)}`
                : `observed ${formatClockUtc(payload.observedAt)}`
            }. ${areaNote ? `${areaNote} ` : ""}Sortable by column.`}
          />
        )
      ) : null}
    </section>
  );
}

/** Map opt-in card. The button label itself names the tile host it connects to. */
function MapOptIn({ onOpen }: { onOpen: () => void }) {
  const host = new URL(basemap.origin).host;
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-5">
      <h2 className="text-base font-semibold tracking-tight">Show these layers on a map</h2>
      <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
        The map draws its background from {host} and renders with WebGL. Loading it connects
        your browser directly to that tile server, which will see your IP address and the tiles
        you request — which is to say, the patch of the world you are looking at. WebGL also
        exposes details of your graphics hardware, which contribute to a browser fingerprint.
        The feature data itself comes from our server either way, and every table below is
        complete without the map.
      </p>
      <Button
        className={cn("mt-4 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left")}
        onClick={onOpen}
      >
        <MapIcon className="size-4 shrink-0" aria-hidden="true" />
        load the map — connects you to {host} and starts WebGL
      </Button>
    </div>
  );
}
