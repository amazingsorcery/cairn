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
 * `/live/flights`. sitemap.md §3, ADR 0014 §5, ADR 0016 §1.
 *
 * `force-dynamic`: the route HTML is never in the Full Route Cache. Only the fetched payload
 * is cached, so there is exactly one clock telling the reader how old the data is. Two cache
 * layers with independent clocks disagreeing about the age would be wrong on the one number
 * that matters most on this page.
 *
 * THE CONNECTOR IS CALLED HERE, ON THE SERVER, so the table is in the initial HTML and the
 * page is usable with no JavaScript at all. `/api/live/flights` exists for the same call from
 * the client during a refresh; both go through `runConnector`, which means both go through
 * the kill-switch, the global ceiling and the per-user quota, and both share one cache entry.
 * There is no path from the browser to the aggregator (ADR 0011 §1).
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
 * The default viewport. Arbitrary and documented as arbitrary: it is a starting point, not a
 * claim about where the interesting aircraft are. A reader changes it by panning the map or
 * by passing `lat`, `lon` and `radius`, and the driver quantises whatever arrives so that one
 * shared cache entry serves many viewers (ADR 0014 §4).
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

  /*
   * Anything that fails validation is dropped, not rejected (sitemap.md §1): a crafted query
   * string must not be able to render an error page. The driver's own Zod schema bounds these
   * again before a request is made.
   */
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

  /*
   * The connector row, read regardless of state. When the kill-switch is off we still render
   * the operator's name and say plainly that it is off (ADR 0014 §2) — which needs the row
   * that `getLiveConnector` deliberately will not return.
   */
  const connector = await getConnectorBySlug(FLIGHTS_CONNECTOR_SLUG);

  /*
   * The quota subject: the signed-in user's id, else the client IP. Both are HMAC-hashed
   * before they reach `rate_limits` or `connector_requests` (ADR 0009, ADR 0013). This route
   * is `force-dynamic` already, so the `auth()` call costs nothing that is not already spent
   * — and it is emphatically NOT a public-route session read (sitemap.md §10.1).
   */
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
             * BOTH OF THESE TRAVEL IN THE ENVELOPE, not as props beside it (QA finding QV-29).
             *
             * `quotaResetsAt` is the REFUSING COUNTER'S own `resetAt`. It used to be recomputed
             * here from `connectors.window_seconds` with a second copy of the epoch-alignment
             * arithmetic — wrong whenever the counter that refused was not the per-user quota,
             * which since QV-25 is most of the time. Then it was passed as a prop, which fixed
             * the arithmetic and left a second bug: a prop is fixed at server render, so a
             * refusal arriving on a client refresh had no instant and therefore no control.
             *
             * `quotaScope` says WHICH counter refused, so the surface names the right limit
             * instead of inferring it from the wording of `message`.
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
