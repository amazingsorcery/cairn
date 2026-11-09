"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Map as MapIcon, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { FlightsDegraded } from "./flights-degraded";
import { FlightsTable, sortDescription, type FlightSort } from "./flights-table";
import { AircraftPanel } from "./aircraft-panel";
import { FreshnessBar } from "./freshness-bar";
import {
  asQuotaScope,
  formatAge,
  formatClockUtc,
  formatNumber,
  formatPosition,
  type FlightsEnvelopeDto,
} from "./live-format";
import { useLiveAge } from "./use-live-age";

/**
 * Client leaf for `/live/flights`; the page is a Server Component that does the fetch.
 *
 * No map here: aircraft are drawn on `/map`, and this page links to it.
 *
 * The freshness bar and table share one payload and one `fetchedAt` so the age can't drift.
 * The initial envelope comes in as a prop, so the table works without JavaScript. Refreshes
 * go to our own `/api/live/flights`, never the upstream, and show no spinner: the data stays
 * on screen with its age counting up.
 */

export interface FlightsSurfaceProps {
  initial: FlightsEnvelopeDto;
  initialAgeSeconds: number | null;
  viewport: { lat: number; lon: number; radius: number };
  /** `connectors.cache_ttl_seconds` — the shared cadence, not a per-viewer preference. */
  refreshSeconds: number;
  operatorName: string | null;
  /** `connectors.per_user_quota` and `connectors.window_seconds`, quoted in the quota message. */
  perUserLimit: number | null;
  windowSeconds: number | null;
}

/**
 * Narrow the JSON from our own route handler. A plain `as` cast would turn a shape change
 * into a blank page instead of a degraded state.
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
      reason === "upstream-down" ||
      reason === "stale" ||
      reason === "quota-exhausted" ||
      reason === "rate-limited" ||
      reason === "disabled"
        ? reason
        : null,
    message: typeof record.message === "string" ? record.message : null,
    connector: typeof record.connector === "string" ? record.connector : fallback.connector,
    /*
     * Needed so a 429 on refresh keeps its reset time and the counter that refused.
     * Unrecognised values become null, which gets the neutral message.
     */
    quotaResetsAt: typeof record.quotaResetsAt === "string" ? record.quotaResetsAt : null,
    quotaScope: asQuotaScope(record.quotaScope),
  };
}

export function FlightsSurface({
  initial,
  initialAgeSeconds,
  viewport,
  refreshSeconds,
  operatorName,
  perUserLimit,
  windowSeconds,
}: FlightsSurfaceProps) {
  const [envelope, setEnvelope] = React.useState<FlightsEnvelopeDto>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [sort, setSort] = React.useState<FlightSort>({ key: "altitudeFt", direction: "desc" });
  const [selectedHex, setSelectedHex] = React.useState<string | null>(null);

  const age = useLiveAge(envelope.fetchedAt, envelope.fetchedAt === initial.fetchedAt ? initialAgeSeconds : null);

  const aircraft = envelope.data?.aircraft ?? [];
  /**
   * Whether to keep polling. `rate-limited` (upstream 429/420) stops polling even with a
   * stale payload on screen: polling makes it worse. The server also enforces a cooldown.
   */
  const live =
    (envelope.state === "fresh" || envelope.state === "stale") &&
    envelope.reason !== "rate-limited";

  /* ---------------------------------------------------------------- *
   * Refresh — always through our own server, never to the upstream
   * ---------------------------------------------------------------- */

  /** The viewport is fixed: it comes from the server-validated query string. */
  const refresh = React.useCallback(
    async () => {
      setRefreshing(true);
      try {
        const query = new URLSearchParams({
          lat: String(viewport.lat),
          lon: String(viewport.lon),
          radius: String(viewport.radius),
        });
        const response = await fetch(`/api/live/flights?${query.toString()}`, { cache: "no-store" });
        const body: unknown = await response.json();
        const parsed = parseEnvelope(body, envelope);
        if (parsed) setEnvelope(parsed);
      } catch {
        // A failed refresh changes nothing; the existing data's age keeps counting up.
      } finally {
        setRefreshing(false);
      }
    },
    [envelope, viewport],
  );

  React.useEffect(() => {
    // No polling when disabled or out of quota; the reader has an explicit control for both.
    if (!live) return;
    const interval = Math.max(5, refreshSeconds) * 1000;
    const timer = window.setInterval(() => {
      // Skip hidden tabs so they don't spend the shared upstream quota.
      if (document.visibilityState !== "visible") return;
      void refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [live, refreshSeconds, refresh]);

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

      {/* The route's single polite live region: count, age and sort order. */}
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
          quotaResetAt={envelope.quotaResetsAt}
          quotaScope={envelope.quotaScope}
          perUserLimit={perUserLimit}
          windowSeconds={windowSeconds}
        />
      ) : (
        <>
          <p className="tabular text-sm text-foreground-secondary">
            {countLine} · within {viewport.radius} nm of{" "}
            <span className="font-mono">{formatPosition(viewport.lat, viewport.lon)}</span>
          </p>

          {/* Pointer to `/map`, which is where aircraft are drawn. */}
          <div className="rounded-lg border border-dashed border-border bg-card p-5">
            <h2 className="text-base font-semibold tracking-tight">
              The map is on a page of its own
            </h2>
            <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
              This page is the table. Aircraft are drawn on the live map, where the same feed
              runs as one toggleable layer alongside the others, and where the map itself is
              still opt-in — nothing is requested from a tile server until you ask for it
              there.
            </p>
            <Link
              href="/map"
              className={buttonVariants({ variant: "default", size: "lg", className: "mt-4" })}
            >
              <MapIcon className="size-4 shrink-0" aria-hidden="true" />
              open the live map
              <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
            </Link>
          </div>

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

      {/* Coverage caveat is always shown: an absent aircraft is not evidence of anything. */}
      <div className="space-y-2 border-t border-border pt-4 text-sm leading-relaxed text-foreground-secondary">
        <p className="max-w-[68ch]">
          Positions are broadcast by aircraft and collected by{" "}
          {operatorName ?? "an open ADS-B aggregator"}. Coverage depends on volunteer receiver
          locations; an aircraft absent from this page is not evidence it is not flying.
        </p>
        {/* Attribution next to the data, not in the footer. */}
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
  "rate-limited": "Aircraft positions paused",
  disabled: "Flight tracking is switched off",
  "bad-request": "That view could not be read",
} as const;

/*
 * Which quota refused comes from `quotaScope` on the envelope. Don't infer it from the
 * `message` text.
 */
