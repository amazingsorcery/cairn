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

/**
 * The question one layer asks about one viewport, as the server's cache key for it.
 *
 * `layerQuery` is the registry deciding what the viewport means to this layer — most layers
 * ignore it entirely — and `sourceQueryKey` is the same normalisation the server keys its
 * payload cache with. Composing them here means the client can tell whether a pan asks
 * something new without knowing which layers are viewport-scoped, and without a second copy of
 * the grid that could disagree with the server's.
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
   * Whether this deployment has case workspaces at all. Passed in from the page because only
   * the server can read the environment, and drilled to `FeatureDetail` rather than read from
   * a context: one boolean, one owner, no provider to forget to mount. In public-only mode
   * `/map/save` answers 404 (ADR 0032), so the control that posts to it must not render.
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
   * What the reader is looking at. The world until the map is open and moved, which is also
   * what the server fetched for, so the two agree before any pan happens.
   *
   * IT IS STATE, BUT IT ONLY MOVES WHEN THE READER STOPS. It was a ref, on the reasoning that
   * nothing renders differently because the viewport moved. That stopped being true with the
   * throttle: a layer whose payload answers a different area than the map now shows has to say
   * so, which is a render. The settler below means this changes at most once per gesture
   * rather than on every `moveend`, so the map is not re-rendering under the reader's hand.
   */
  const [viewport, setViewport] = React.useState<MapViewport>(WORLD);
  /* The same value, readable synchronously by a fetch that a timer started. */
  const viewportRef = React.useRef<MapViewport>(WORLD);
  /* Where the last `moveend` left the map, before the settler has accepted it. */
  const pendingViewportRef = React.useRef<MapViewport | null>(null);
  /*
   * THE QUESTION EACH LAYER'S PAYLOAD ANSWERS, as the server's own cache key.
   *
   * Not "where the reader was when we asked": two viewports a few hundred metres apart ask the
   * same question, and a global feed asks the same question wherever the reader is. Comparing
   * keys rather than positions is what lets the throttle skip a pan that needs no request, and
   * it is computed by the same function the server keys its cache with, so the two cannot
   * drift — the drift between key and question being QV-04 itself.
   */
  const [answeredKeys, setAnsweredKeys] = React.useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(MAP_LAYERS.map((layer) => [layer.id, queryKeyFor(layer, WORLD)])),
  );
  /** When we last sent a request per layer, whatever came back. Paces every automatic path. */
  const requestedAtRef = React.useRef<Record<string, number>>({});
  /*
   * The page render counts as a request for pacing purposes. Without it a layer whose
   * server-side fetch failed would be re-requested by the first tick after hydration, which
   * is a burst at exactly the moment an upstream is already in trouble.
   *
   * It is dated from the OBSERVATION, not from mount: the server may have rendered from a
   * cache entry most of a TTL old, and pretending we had just asked would hold a payload that
   * is already due for another whole TTL. `initialAges` is the age the server computed, which
   * is the same number the status row shows, so the client's pacing and the reader's clock
   * agree. A failed initial payload has no age and falls back to mount.
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
       * The viewport travels with every refresh, and the registry decides per layer whether
       * it means anything (`MapLayerDefinition.query`). It is quantised to a whole-degree grid
       * on the server, once, where the cache key is built from the same value — so many
       * readers looking at roughly the same place share one upstream call and one cache entry
       * (ADR 0014 §4), and the coordinate an upstream sees is coarser than the reader's.
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
      /*
       * Recorded for the answer we actually received, success or failure — what is now on
       * screen is the response to *this* question. It is deliberately not recorded when the
       * request never completed (the catch below), because then the payload still on screen is
       * still the answer to whatever it was before.
       */
      if (requestedKey !== null) {
        setAnsweredKeys((current) => ({ ...current, [layerId]: requestedKey }));
      }
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

  /**
   * THE ONE PLACE AN AUTOMATIC REQUEST IS DECIDED, for every layer and every reason.
   *
   * Ageing out, recovering from a failure and following the reader's viewport used to be
   * three code paths with three different opinions about when we may call a source. They are
   * one call to `refreshReason` now, which is pure and tested (`refresh-policy.test.ts`), so
   * "how many upstream calls can a five-second drag make" is a question with an answer that
   * does not require reading a component.
   *
   * A layer is skipped when it is switched off and when the tab is hidden. The second is not
   * an optimisation: a hidden tab is not a reader, and refreshing it spends a shared ceiling
   * that exists to keep us inside somebody's fair-use policy.
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
   * ONE TIMER FOR EVERY LAYER, not one per layer. It wakes on a fixed tick and asks the policy
   * about each visible layer; most ticks decide nothing. The tick is a heartbeat rather than a
   * cadence — the cadence is each source's own TTL, which is a registry column an operator can
   * change under load, and never a number chosen in the UI.
   *
   * It is also what makes the throttle self-correcting: a pan that arrives inside a layer's
   * minimum gap is not dropped, it is simply not due yet, and the next tick after the gap
   * expires picks it up without the reader touching anything.
   */
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      evaluateRef.current(Date.now());
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /* The reader stopped somewhere new: decide at once rather than waiting for the next tick. */
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
   * The reader panned. **Nothing is fetched here.**
   *
   * This used to call `refreshLayer` for every visible viewport-scoped layer on every
   * `moveend`, with no throttle — harmless only for as long as the server cache answered any
   * viewport from one entry, which is precisely the defect (QV-04) being fixed. Keying the
   * cache on the query without also throttling the pan would have turned a drag into a burst
   * of cold misses and ADR 0021's six-calls-a-minute ceiling into a `quotaExhausted` layer.
   * The two are one change.
   *
   * So the gesture only records where the reader ended up. `moveend` fires at the end of each
   * sub-gesture of a drag; the settler collapses them into one settled viewport, and the
   * effect above it decides — per layer, through the policy — whether that viewport asks a
   * question we have not already answered.
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

  /**
   * THE SENTENCE A THROTTLED LAYER OWES THE READER, or null when it owes none.
   *
   * The throttle buys the upstream's fair-use ceiling with a window in which the payload on
   * screen answers the area the reader was looking at a moment ago rather than the one they
   * are looking at now. That window is short and bounded, but a table captioned "58 features,
   * observed 03:39" over an empty map is the exact shape of QV-04 — so for as long as it
   * lasts, the layer says so, in the caption the screen reader hears and in the announcement.
   *
   * It is derived from the registry rather than from a list of layer names: a layer with no
   * `query` can never be in this state, because its key does not move when the reader does.
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
          /* A registry says when it was checked; a feed says how old it is. Registry field,
             not a branch on which layer this is. */
          cadence={layer.cadence ?? "live"}
          refreshing={refreshing}
          initialAgeSeconds={initialAgeSeconds}
          onRetry={onRetry}
        />
      ) : null}

      {/*
        Visible as well as in the caption. A sighted reader watching the map move needs the
        same qualification a screen-reader user gets from the caption, and neither should have
        to infer it from a count that has not changed.
      */}
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
