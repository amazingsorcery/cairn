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
import {
  MAP_LAYERS,
  findLayer,
  type LayerPayloadDto,
  type MapLayerDefinition,
  type MapViewport,
  type TableSort,
} from "./registry";
import { sortDescription } from "./sort";
import { useReducedMotion, useResolvedTheme } from "./use-map-environment";

/**
 * The map route's one interactive leaf. The page around it is a Server Component that does
 * the fetching, so every table is complete in the initial HTML.
 *
 * ## What this component does NOT contain
 *
 * The name of any layer. It iterates `MAP_LAYERS` and asks each definition for its deck.gl
 * layer, its columns, its detail rows and its empty sentence. `grep -n earthquake` in this
 * file returns nothing, and `registry.test.ts` fails the build if that stops being true.
 *
 * ## Why the interactive part is one leaf rather than five
 *
 * The controls, the map, the tables and the detail panel all read the same payloads and the
 * same observation instants. Split across five components with five copies of that state
 * they would drift, and the numbers that must never drift on a live surface are the counts
 * and the ages (ADR 0014 §1). One owner, one clock, one payload per layer.
 *
 * ## The map is opt-in and the tables are not
 *
 * WebGL is a fingerprinting surface and a tile server sees the patch of the world a reader
 * is looking at, so nothing loads until the reader asks (ADR 0019). The tables below carry
 * every feature either way — they are the equivalent, not the fallback.
 */

type MapState = "closed" | "loading" | "ready" | "failed";

/**
 * The viewport before the reader has moved anything, matching what the server fetched for.
 * ±85° rather than ±90 because Web Mercator does not reach the poles.
 */
const WORLD: MapViewport = { west: -180, south: -85, east: 180, north: 85 };

export interface MapSurfaceProps {
  /** One entry per layer in the registry, fetched on the server. */
  initialPayloads: Readonly<Record<string, LayerPayloadDto>>;
  /** Age in whole seconds at server render time, per layer. Keeps hydration honest. */
  initialAges: Readonly<Record<string, number | null>>;
  /** Layer ids visible on first paint, from the registry's own defaults. */
  initialVisible: readonly string[];
  initialView: { longitude: number; latitude: number; zoom: number };
}

export function MapSurface({
  initialPayloads,
  initialAges,
  initialVisible,
  initialView,
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
   * What the reader is looking at. The world until the map is open and moved, which is also
   * what the server fetched for, so the two agree before any pan happens.
   *
   * A REF, NOT STATE. Nothing renders differently because the viewport moved — it is an input
   * to the next fetch and nothing else. Holding it in state would re-render the whole surface
   * on every `moveend`, which on a map means re-rendering while the reader is still using it.
   */
  const viewportRef = React.useRef<MapViewport>(WORLD);
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
    try {
      /*
       * The viewport travels with every refresh, and the registry decides per layer whether
       * it means anything (`MapLayerDefinition.query`). The server rounds it to whole degrees
       * before it reaches a source, so many readers looking at roughly the same place share
       * one upstream call and one cache entry rather than each generating their own.
       */
      const view = viewportRef.current;
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
    } catch {
      /*
       * A failed refresh changes nothing on screen. The payload already here keeps its own
       * observation instant, so its age simply keeps counting up and the reader watches it
       * get older — which is honest, and is the opposite of a spinner that keeps asserting
       * that fresh data is arriving.
       */
    } finally {
      setRefreshing((current) => {
        const next = new Set(current);
        next.delete(layerId);
        return next;
      });
    }
  }, []);

  /*
   * ONE TIMER FOR EVERY LAYER, not one per layer. It wakes every five seconds and refreshes
   * any visible layer whose data is older than its own source's TTL — so the cadence is the
   * adapter's `ttlSeconds`, which is set to respect the upstream's documented rate limit, and
   * never a number chosen in the UI.
   *
   * A layer is skipped when it is switched off, when its last answer was a failure that
   * polling cannot fix, and when the tab is hidden. The last is not an optimisation: a hidden
   * tab is not a reader, and refreshing it spends a shared ceiling that exists to keep us
   * inside somebody's fair-use policy.
   */
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      for (const layer of MAP_LAYERS) {
        if (!visible.has(layer.id)) continue;
        const payload = payloads[layer.id];
        if (!payload) continue;
        if (!payload.ok) {
          /*
           * `rateLimited` means the UPSTREAM refused us. Every other failure is a condition
           * polling might resolve; this one is a condition polling makes worse. Continuing to
           * call a service that has asked us to stop is the breach product-brief §3.2
           * constraint 5 forbids, and it is what QA finding Q-02 was about on `/live/flights`.
           */
          continue;
        }
        if (ageSeconds(payload.observedAt, now) < payload.source.ttlSeconds) continue;
        void refreshLayer(layer.id);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, payloads, refreshLayer]);

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
   * The reader panned. Only layers whose source is scoped to a viewport are re-fetched.
   *
   * A global feed does not change because somebody scrolled, and calling USGS again for the
   * same worldwide payload would spend an upstream's goodwill on nothing. Which layers care
   * is a registry fact (`MapLayerDefinition.query`), not a list kept here.
   */
  const handleViewportChange = React.useCallback(
    (next: MapViewport) => {
      viewportRef.current = next;
      for (const layer of MAP_LAYERS) {
        if (!layer.query || !visible.has(layer.id)) continue;
        void refreshLayer(layer.id);
      }
    },
    [visible, refreshLayer],
  );

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
    /* Focus goes back where it came from. A reader who opened a row lands on that row. */
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

  const selectedLayer = selected ? findLayer(selected.layerId) : null;
  const selectedPayload = selected ? payloads[selected.layerId] : undefined;
  const selectedFeature =
    selected && selectedPayload?.ok
      ? (selectedPayload.features.find((f) => f.id === selected.featureId) ?? null)
      : null;

  /**
   * The age of a payload, WITHOUT a ticking clock.
   *
   * TWO REASONS IT DOES NOT TICK, and both are load-bearing.
   *
   * First, hydration. Calling `Date.now()` during the first client render produces a
   * different number from the one the server rendered, and React discards the whole tree as
   * a mismatch. The server already computed each layer's age once and passed it in, so while
   * a payload is still the one the server sent, its age is the number the server sent.
   *
   * Second, and more important: this feeds the polite live region. A live region whose text
   * changes every second makes a screen reader announce the page once a second, which is not
   * an age indicator, it is an alarm. The visible age in each layer's status row is the one
   * that ticks (`useLiveAge`), because a sighted reader glances at it and a screen reader
   * does not have it read aloud on a timer.
   */
  const ageAt = React.useCallback(
    (layerId: string, payload: Extract<LayerPayloadDto, { ok: true }>): number =>
      payload === initialPayloads[layerId]
        ? (initialAges[layerId] ?? 0)
        : ageSeconds(payload.observedAt),
    [initialPayloads, initialAges],
  );

  /**
   * THE ROUTE'S ONE POLITE LIVE REGION (`HANDOFF-shell.md` §10.1).
   *
   * It is in the DOM before the content it describes, it is never duplicated, and it carries
   * what a reader who cannot see the screen needs after any change: which layers are on, how
   * many features each has, how old they are, and how the tables are ordered.
   */
  const announcement = visibleLayers
    .map((layer) => {
      const payload = payloads[layer.id];
      if (!payload) return `${layer.label}: not loaded.`;
      if (!payload.ok) return `${layer.unavailableTitle}.`;
      const sort = sorts[layer.id];
      /*
       * A registry is announced by the day it was checked, not by an age. `observedAt` for a
       * hand-verified list is a verification date, and reading "26 hours ago" aloud states
       * decay where there is none. The vocabulary is `layer-status.tsx`'s, imported rather
       * than restated, so the announcement and the visible row cannot drift apart.
       */
      const freshness =
        layer.cadence === "registry"
          ? `checked ${formatCheckedDate(payload.observedAt)}`
          : formatAge(ageAt(layer.id, payload));
      return `${layer.label}: ${formatNumber(payload.features.length)} ${
        payload.features.length === 1 ? "feature" : "features"
      }, ${freshness}. ${sort ? sortDescription(layer, sort) : ""}`;
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
              {/* A word, not a spinner. ADR 0014 §8. */}
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

        {/*
          On a phone this is the second element and sits directly under the map, in the lower
          half of the screen and inside thumb reach. At `md` it moves to a right rail.
        */}
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

/**
 * One layer's section: its state, its source, and its table.
 *
 * Registry-driven throughout. The only thing this function knows about the layer is that it
 * has a label, a payload and columns.
 */
function LayerSection({
  layer,
  payload,
  initialAgeSeconds,
  refreshing,
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
          /* A registry says when it was checked; a feed says how old it is. Registry field,
             not a branch on which layer this is. */
          cadence={layer.cadence ?? "live"}
          refreshing={refreshing}
          initialAgeSeconds={initialAgeSeconds}
          onRetry={onRetry}
        />
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
            }. Sortable by column.`}
          />
        )
      ) : null}
    </section>
  );
}

/**
 * The opt-in card.
 *
 * The consequence is IN the button's label, not only in the paragraph above it — the pattern
 * ADR 0015 established for camera embeds, applied to the tile provider. A reader who reads
 * only the control still learns what pressing it does.
 */
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
