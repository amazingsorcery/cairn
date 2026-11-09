import { headers } from "next/headers";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { FlightsSurface } from "@/components/live/flights-surface";
import { ageSeconds, type LiveReason } from "@/components/live/live-format";
import { auth } from "@/lib/auth";
import { FLIGHTS_CONNECTOR_SLUG, flightsDriver, runConnector } from "@/lib/connectors";
import { pageMetadata } from "@/lib/metadata";
import { getConnectorBySlug } from "@/lib/queries/live";
import { clientSubject } from "@/lib/rate-limit";

/**
 * `/live/flights`. `force-dynamic` so only the payload is cached and the data age has a
 * single clock.
 *
 * The connector runs server-side so the table is in the initial HTML (works without JS).
 * Client refreshes use `/api/live/flights`; both go through `runConnector` (kill-switch,
 * global ceiling, per-user quota, shared cache). The browser never talks to the aggregator.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = pageMetadata({
  title: "Live flights",
  description:
    "Aircraft positions from an open ADS-B aggregator, as a sortable table with an opt-in map. Fetched by our server, never by your browser, and labelled with how old it is.",
  path: "/live/flights",
});

/**
 * Arbitrary default viewport. Overridable via `lat`, `lon`, `radius`; the driver quantises
 * these so one cache entry serves many viewers.
 */
const DEFAULT_VIEWPORT = { lat: 51.5, lon: -0.1, radius: 50 } as const;

function readViewport(params: Record<string, string | string[] | undefined>) {
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const lat = Number(single("lat"));
  const lon = Number(single("lon"));
  const radius = Number(single("radius"));

  // Invalid values fall back to defaults rather than erroring. The driver's Zod schema re-checks.
  return {
    lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : DEFAULT_VIEWPORT.lat,
    lon: Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : DEFAULT_VIEWPORT.lon,
    radius: Number.isFinite(radius) && radius >= 1 && radius <= 250 ? radius : DEFAULT_VIEWPORT.radius,
  };
}

export default async function LiveFlightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewport = readViewport(await searchParams);

  // Read regardless of state so a switched-off connector can still be named.
  const connector = await getConnectorBySlug(FLIGHTS_CONNECTOR_SLUG);

  // Quota subject: user id, else client IP. Both are HMAC-hashed before storage.
  // `auth()` is fine here since the route is already dynamic.
  const session = await auth();
  const requestHeaders = await headers();
  const subject =
    session?.user?.id ?? clientSubject(new Request("http://internal", { headers: requestHeaders }));

  const envelope = await runConnector(flightsDriver, viewport, { subject });

  const now = new Date();
  const initialAgeSeconds = envelope.fetchedAt ? ageSeconds(envelope.fetchedAt, now.getTime()) : null;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb items={[{ label: "live", href: "/live" }, { label: "flights" }]} />

      <div className="mt-4 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Flights</h1>
        <p className="mt-3 text-lg text-foreground-secondary">
          Aircraft broadcast their own position, altitude and callsign in the clear. This is
          that broadcast, collected by a volunteer receiver network and fetched by our server
          rather than by your browser.
        </p>
      </div>

      <div className="mt-8">
        <FlightsSurface
          initial={{
            state: envelope.state,
            fetchedAt: envelope.fetchedAt?.toISOString() ?? null,
            data: envelope.data,
            attribution: envelope.attribution,
            reason: (envelope.reason as LiveReason | null) ?? null,
            message: envelope.lastError,
            connector: envelope.connectorSlug,
            /*
             * Part of the envelope so client refreshes get them too. `quotaResetsAt` is the
             * refusing counter's own reset time; `quotaScope` says which counter refused.
             */
            quotaResetsAt: envelope.quotaResetsAt?.toISOString() ?? null,
            quotaScope: envelope.quotaScope,
          }}
          initialAgeSeconds={initialAgeSeconds}
          viewport={viewport}
          refreshSeconds={connector?.cacheTtlSeconds ?? 15}
          operatorName={connector?.operatorName ?? null}
          perUserLimit={connector?.perUserQuota ?? null}
          windowSeconds={connector?.windowSeconds ?? null}
        />
      </div>
    </div>
  );
}
