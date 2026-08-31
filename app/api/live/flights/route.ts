import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { flightsDriver, runConnector } from "@/lib/connectors";
import { clientSubject } from "@/lib/rate-limit";

/**
 * The server-side ADS-B proxy behind `/live/flights`. ADR 0011 §1, sitemap.md §3.
 *
 * THE POINT OF THIS ROUTE IS THAT THE BROWSER NEVER TALKS TO THE UPSTREAM. A direct client
 * fetch would hand the aggregator the user's IP and their viewport — that is, the patch of
 * the world they are looking at — which is precisely the interest-graph leak product-brief
 * §3.2 constraint 4 exists to prevent. Everything about this endpoint follows from that.
 *
 * It always returns 200 with an envelope, even when the upstream is down. ADR 0011 rule 5
 * and ADR 0014: the surface must say what is wrong and how old the data is. An HTTP error
 * would hand the client an error boundary and lose both.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  /**
   * The quota subject: the signed-in user's id if there is one, otherwise the client IP.
   * Both are hashed before they reach `rate_limits` or `connector_requests` (ADR 0009,
   * ADR 0013) — nothing identifying is stored on either side of this call.
   */
  const session = await auth();
  const subject = session?.user?.id ?? clientSubject(request);

  const envelope = await runConnector(
    flightsDriver,
    {
      lat: url.searchParams.get("lat"),
      lon: url.searchParams.get("lon"),
      radius: url.searchParams.get("radius") ?? undefined,
    },
    { subject },
  );

  /**
   * `fetchedAt` is serialised as an ISO string and the client computes the age from it on
   * every tick (ADR 0014 §1). The age is NOT computed here: a number baked in at response
   * time is wrong the moment the response is a second old, and this is the one number on the
   * page that must never be wrong.
   */
  return NextResponse.json(
    {
      state: envelope.state,
      fetchedAt: envelope.fetchedAt?.toISOString() ?? null,
      data: envelope.data,
      attribution: envelope.attribution,
      reason: envelope.reason,
      message: envelope.lastError,
      connector: envelope.connectorSlug,
    },
    { headers: NO_STORE },
  );
}
