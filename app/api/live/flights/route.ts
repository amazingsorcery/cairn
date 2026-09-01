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
 * It returns 200 with an envelope even when the upstream is down. ADR 0011 rule 5 and
 * ADR 0014: the surface must say what is wrong and how old the data is, and an empty error
 * response would lose both.
 *
 * ── THE ONE EXCEPTION: 429 WHEN A QUOTA OF OURS REFUSED THE CALLER ─────────
 * Rule 5 governs the BODY, and a 429 that carries the same renderable envelope satisfies it
 * completely — the client reads `reason` exactly as before. The status code is the half that
 * monitoring, a reverse proxy and a CDN can act on, and `/map/data/[slug]` already answers
 * 429 for this condition (QA finding QV-05). Two routes answering one condition with two
 * status codes was the inconsistency, not the 429.
 *
 * It is deliberately narrow. `disabled` stays 200: a kill-switch is a decision, not a limit,
 * and no amount of waiting clears it. `rate-limited` stays 200: that is a refusal THEY made,
 * and telling a client to retry against our own header would be us advertising somebody
 * else's limit as ours.
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
  /**
   * `Retry-After` in whole seconds, rounded UP and taken from the limiter's own reset instant
   * (`quotaResetsAt`) rather than recomputed from a window length here. Rounded up because a
   * client that waits the rounded-down value arrives one request short of the reset and is
   * refused again, which teaches clients to ignore the header.
   *
   * Absent when the reset instant is unknown — the limiter itself failed and we refused fail
   * closed. A 429 with no `Retry-After` is honest; a guessed one is not.
   */
  const refused = envelope.reason === "quota-exhausted";
  const retryAfterSeconds =
    refused && envelope.quotaResetsAt
      ? Math.max(1, Math.ceil((envelope.quotaResetsAt.getTime() - Date.now()) / 1000))
      : null;

  return NextResponse.json(
    {
      state: envelope.state,
      fetchedAt: envelope.fetchedAt?.toISOString() ?? null,
      data: envelope.data,
      attribution: envelope.attribution,
      reason: envelope.reason,
      message: envelope.lastError,
      connector: envelope.connectorSlug,
      /**
       * Sent in the body as well as the header so the surface can render "try again at
       * 08:26" rather than a bare count, and so the client is not made to parse a header it
       * would otherwise never read. Null unless a quota refused this caller.
       */
      quotaResetsAt: refused ? (envelope.quotaResetsAt?.toISOString() ?? null) : null,
    },
    {
      status: refused ? 429 : 200,
      headers: {
        ...NO_STORE,
        ...(retryAfterSeconds === null ? {} : { "Retry-After": String(retryAfterSeconds) }),
      },
    },
  );
}
