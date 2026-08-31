"use client";

import * as React from "react";
import { Map as MapIcon, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mapTiles } from "@/config/live";
import { FlightsDegraded } from "./flights-degraded";
import { FlightsTable, sortDescription, type FlightSort } from "./flights-table";
import { AircraftPanel } from "./aircraft-panel";
import { FreshnessBar } from "./freshness-bar";
import type { FlightsMapProps } from "./flights-map";
import {
  formatAge,
  formatClockUtc,
  formatNumber,
  formatPosition,
  type FlightsEnvelopeDto,
} from "./live-format";
import { useLiveAge } from "./use-live-age";

/**
 * `/live/flights`. The one interactive leaf on the route; the page around it is a Server
 * Component that does the data fetch.
 *
 * WHY THE INTERACTIVE PART IS ONE LEAF RATHER THAN THREE. The freshness bar, the table and
 * the map all read the same payload and the same `fetchedAt`. Split across three components
 * with three copies of the state they would drift, and the one number on this page that must
 * never be wrong is the age (ADR 0014 §1). One owner, one clock, one payload.
 *
 * IT IS SERVER-RENDERED FIRST. The page passes the initial envelope in as a prop, so the
 * table is present in the initial HTML and is fully readable with no JavaScript at all —
 * which is the point of ADR 0016 §1 making the table primary. What JavaScript adds is
 * sorting, the detail panel, the ticking age and the opt-in map. What it never adds is a
 * request to the upstream: refreshes go to `/api/live/flights`, which is our own server
 * (ADR 0011 §1).
 *
 * NO SPINNER ON A REFRESH (ADR 0014 §8). The current data stays on screen with its age
 * counting up. The only loading indicator on this route is the first-load one in
 * `loading.tsx`, when there is genuinely nothing to show yet.
 */

export interface FlightsSurfaceProps {
  initial: FlightsEnvelopeDto;
  initialAgeSeconds: number | null;
  viewport: { lat: number; lon: number; radius: number };
  /** `connectors.cache_ttl_seconds` — the shared cadence, not a per-viewer preference. */
  refreshSeconds: number;
  operatorName: string | null;
  /** ISO instant the fixed-window quota clears, when one is exhausted. */
  quotaResetAt: string | null;
  perUserLimit: number | null;
  windowSeconds: number | null;
}

type MapState = "closed" | "loading" | "ready" | "failed";

/**
 * Narrow the JSON from our own route handler. Zod at every boundary includes this one: the
 * response is same-origin and ours, but "it is ours" is exactly the assumption that stops
 * being true after a refactor, and an `as` cast here would turn a shape change into a blank
 * page rather than a degraded state.
 */
function parseEnvelope(value: unknown, fallback: FlightsEnvelopeDto): FlightsEnvelopeDto | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== "fresh" && state !== "stale" && state !== "unavailable") return null;

  const fetchedAt = typeof record.fetchedAt === "string" ? record.fetchedAt : null;
  const reason = record.reason;
  const data = record.data;

  return {
    state,
    fetchedAt,
    data:
      typeof data === "object" && data !== null && Array.isArray((data as { aircraft?: unknown }).aircraft)
        ? (data as FlightsEnvelopeDto["data"])
        : null,
    attribution: typeof record.attribution === "string" ? record.attribution : fallback.attribution,
    reason:
      reason === "upstream-down" || reason === "stale" || reason === "quota-exhausted" || reason === "disabled"
        ? reason
        : null,
    message: typeof record.message === "string" ? record.message : null,
    connector: typeof record.connector === "string" ? record.connector : fallback.connector,
  };
}

export function FlightsSurface({
  initial,
  initialAgeSeconds,
  viewport: initialViewport,
  refreshSeconds,
  operatorName,
  quotaResetAt,
  perUserLimit,
  windowSeconds,
}: FlightsSurfaceProps) {
  const [envelope, setEnvelope] = React.useState<FlightsEnvelopeDto>(initial);
  const [viewport, setViewport] = React.useState(initialViewport);
  const [refreshing, setRefreshing] = React.useState(false);
  const [sort, setSort] = React.useState<FlightSort>({ key: "altitudeFt", direction: "desc" });
  const [selectedHex, setSelectedHex] = React.useState<string | null>(null);
  const [mapState, setMapState] = React.useState<MapState>("closed");
  const [MapComponent, setMapComponent] =
    React.useState<React.ComponentType<FlightsMapProps> | null>(null);

  const age = useLiveAge(envelope.fetchedAt, envelope.fetchedAt === initial.fetchedAt ? initialAgeSeconds : null);

  const aircraft = envelope.data?.aircraft ?? [];
  const live = envelope.state === "fresh" || envelope.state === "stale";

  /* ---------------------------------------------------------------- *
   * Refresh — always through our own server, never to the upstream
   * ---------------------------------------------------------------- */

  const refresh = React.useCallback(
    async (next: { lat: number; lon: number; radius: number }) => {
      setRefreshing(true);
      try {
        const query = new URLSearchParams({
          lat: String(next.lat),
          lon: String(next.lon),
          radius: String(next.radius),
        });
        const response = await fetch(`/api/live/flights?${query.toString()}`, { cache: "no-store" });
        const body: unknown = await response.json();
        const parsed = parseEnvelope(body, envelope);
        if (parsed) setEnvelope(parsed);
      } catch {
        /*
         * A failed refresh changes nothing on screen. The payload that is already here keeps
         * its own `fetchedAt`, so the age simply keeps counting up and the reader watches it
         * get older — which is the honest thing to show and the opposite of a spinner that
         * keeps asserting fresh data is arriving.
         */
      } finally {
        setRefreshing(false);
      }
    },
    [envelope],
  );

  React.useEffect(() => {
    /*
     * No polling when the connector is switched off or a quota is exhausted. In the first
     * case no outbound call would be made anyway and we would only be talking to ourselves;
     * in the second, polling a limit we have already reached is what caused it. The reader
     * has an explicit control for both.
     */
    if (!live) return;
    const interval = Math.max(5, refreshSeconds) * 1000;
    const timer = window.setInterval(() => {
      // A hidden tab is not a reader. Refreshing it burns the shared global ceiling that
      // exists to keep us inside the upstream's fair use (ADR 0011 rule 3).
      if (document.visibilityState !== "visible") return;
      void refresh(viewport);
    }, interval);
    return () => window.clearInterval(timer);
  }, [live, refreshSeconds, refresh, viewport]);

  /* ---------------------------------------------------------------- *
   * The map — loaded on request, and never on page load
   * ---------------------------------------------------------------- */

  async function openMap() {
    setMapState("loading");
    try {
      // Not named `module`: Next forbids assigning that identifier because it collides
      // with the CommonJS free variable during bundling (@next/next/no-assign-module-variable).
      const mapModule = await import("./flights-map");
      setMapComponent(() => mapModule.default);
      setMapState("ready");
    } catch {
      // The table is the primary surface and is untouched by this. ADR 0016 §1: "the flights
      // table must remain fully usable if it fails to load".
      setMapState("failed");
    }
  }

  const selected = selectedHex ? (aircraft.find((a) => a.hex === selectedHex) ?? null) : null;

  const countLine = `${formatNumber(aircraft.length)} ${aircraft.length === 1 ? "aircraft" : "aircraft"} in view`;

  return (
    <div className="space-y-6">
      <FreshnessBar
        state={envelope.state}
        fetchedAt={envelope.fetchedAt}
        initialAgeSeconds={age}
        reason={envelope.reason}
        refreshing={refreshing}
        unavailableTitle={UNAVAILABLE_TITLE[envelope.reason ?? "upstream-down"]}
      />

      {/*
        THE ROUTE'S ONE POLITE LIVE REGION (HANDOFF-shell.md §10.1). It is in the DOM before
        the content it describes, it is never duplicated, and it carries the three things a
        reader who cannot see the screen needs to know: how many aircraft, how old, and how
        the table is currently ordered.
      */}
      <p aria-live="polite" className="sr-only">
        {live
          ? `${countLine}. ${age === null ? "" : `Positions are ${formatAge(age)}.`} ${sortDescription(sort)}`
          : UNAVAILABLE_TITLE[envelope.reason ?? "upstream-down"]}
      </p>

      {envelope.state === "stale" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>These positions are {age === null ? "out of date" : `${age} seconds old`}</AlertTitle>
          <AlertDescription>
            Aircraft have moved since.{" "}
            {refreshing ? "Refreshing in the background." : "The next refresh is due shortly."}
          </AlertDescription>
        </Alert>
      ) : null}

      {!live ? (
        <FlightsDegraded
          reason={envelope.reason ?? "upstream-down"}
          operatorName={operatorName}
          lastGoodAt={envelope.fetchedAt}
          lastGoodAgeSeconds={age}
          quotaResetAt={quotaResetAt}
          perViewerQuota={isPerViewerQuota(envelope.message)}
          perUserLimit={perUserLimit}
          windowSeconds={windowSeconds}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="tabular text-sm text-foreground-secondary">
              {countLine} · within {viewport.radius} nm of{" "}
              <span className="font-mono">{formatPosition(viewport.lat, viewport.lon)}</span>
            </p>
            {mapState === "closed" ? null : (
              <Button
                variant="ghost"
                className="h-11"
                onClick={() => {
                  setMapState("closed");
                  setMapComponent(null);
                }}
              >
                hide the map
              </Button>
            )}
          </div>

          {/* The map is opt-in, and the disclosure is above the control that triggers it. */}
          {mapState === "closed" ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-5">
              <h2 className="text-base font-semibold tracking-tight">Show these aircraft on a map</h2>
              <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
                The map draws its background from {new URL(mapTiles.origin).host}. Loading it
                connects your browser directly to that tile server, which will see your IP
                address and the tiles you request — which is to say, the patch of the world you
                are looking at. Aircraft positions themselves come from our server either way,
                so nothing loads until you choose it.
              </p>
              {/*
                `whitespace-normal` and `h-auto`: the label carries the consequence, so it is
                long, and at 375px a nowrap button would push the whole page into a horizontal
                scroll. The label is not shortened to fit — the consequence being IN the label
                is the point (ADR 0015 §2 applied to the tile provider).
              */}
              <Button
                className="mt-4 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
                onClick={() => void openMap()}
              >
                <MapIcon className="size-4 shrink-0" aria-hidden="true" />
                load the map — connects you to {new URL(mapTiles.origin).host}
              </Button>
            </div>
          ) : null}

          {mapState === "loading" ? (
            <div>
              <Skeleton className="h-[60vh] min-h-[20rem] w-full" />
              <p className="mt-2 text-sm text-foreground-secondary">Loading the map…</p>
            </div>
          ) : null}

          {mapState === "failed" ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>The map didn&rsquo;t load</AlertTitle>
              <AlertDescription>
                The map code could not be fetched. The table below lists every aircraft in view
                and is unaffected.
                <span className="mt-3 block">
                  <Button variant="secondary" className="h-11" onClick={() => void openMap()}>
                    retry the map
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          {mapState === "ready" && MapComponent ? (
            <>
              <MapComponent
                aircraft={aircraft}
                center={{ lat: viewport.lat, lon: viewport.lon }}
                radius={viewport.radius}
                selectedHex={selectedHex}
                onSelect={setSelectedHex}
                onViewportChange={(next) => {
                  setViewport(next);
                  void refresh(next);
                }}
              />
              <p className="text-sm text-foreground-secondary">
                Map tiles{" "}
                <a
                  href={mapTiles.attributionUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline underline-offset-4"
                >
                  {mapTiles.attribution}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </p>
            </>
          ) : null}

          {selected ? (
            <AircraftPanel
              aircraft={selected}
              fetchedAt={envelope.fetchedAt}
              fetchedAgeSeconds={age}
              onClose={() => setSelectedHex(null)}
            />
          ) : null}

          {aircraft.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-lg font-semibold tracking-tight">No aircraft in this area</h2>
              <p className="mt-2 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
                {operatorName ?? "The aggregator"} answered and reported no aircraft within{" "}
                {viewport.radius} nautical miles of{" "}
                <span className="font-mono">{formatPosition(viewport.lat, viewport.lon)}</span>
                {envelope.fetchedAt ? (
                  <>
                    {" "}
                    at <span className="tabular">{formatClockUtc(envelope.fetchedAt)}</span>
                  </>
                ) : null}
                . Coverage depends on volunteer receiver locations, so this is not evidence that
                nothing is flying there.
              </p>
            </div>
          ) : (
            <FlightsTable
              aircraft={aircraft}
              sort={sort}
              onSortChange={setSort}
              selectedHex={selectedHex}
              onSelect={(hex) => setSelectedHex((current) => (current === hex ? null : hex))}
              caption={`Aircraft reported within ${viewport.radius} nautical miles of ${formatPosition(viewport.lat, viewport.lon)}${envelope.fetchedAt ? `, as of ${formatClockUtc(envelope.fetchedAt)}` : ""}. Sortable by column.`}
            />
          )}
        </>
      )}

      {/*
        ALWAYS RENDERED, never collapsed (states.md §5.1). The coverage caveat is not a
        footnote: an audience that publishes based on what it sees here needs to know that an
        absence is not evidence, and it needs to know it on the same screen as the data.
      */}
      <div className="space-y-2 border-t border-border pt-4 text-sm leading-relaxed text-foreground-secondary">
        <p className="max-w-[68ch]">
          Positions are broadcast by aircraft and collected by{" "}
          {operatorName ?? "an open ADS-B aggregator"}. Coverage depends on volunteer receiver
          locations; an aircraft absent from this page is not evidence it is not flying.
        </p>
        {/* Attribution next to the data, never in the footer. ADR 0011 rule 2. */}
        {envelope.attribution ? (
          <p className="max-w-[68ch] font-medium text-foreground">{envelope.attribution}</p>
        ) : null}
      </div>
    </div>
  );
}

const UNAVAILABLE_TITLE = {
  "upstream-down": "Aircraft positions unavailable",
  stale: "Aircraft positions unavailable",
  "quota-exhausted": "Aircraft positions paused",
  disabled: "Flight tracking is switched off",
} as const;

/**
 * Which of the two quotas refused the call.
 *
 * The envelope does not carry a discriminator, so this reads the sentence `runConnector`
 * put in `lastError` — the two strings are written in `lib/connectors/runtime.ts` and are
 * the only sentences that reach here for a quota refusal. It is a coupling to a message and
 * it is recorded as such in `docs/frontend/HANDOFF-live.md`: the right fix is a field on
 * `DegradedReason`, which is the backend's to add. Until then this defaults to the SHARED
 * ceiling, which is the reading that blames us rather than the reader.
 */
function isPerViewerQuota(message: string | null): boolean {
  return message?.startsWith("You have reached") ?? false;
}
