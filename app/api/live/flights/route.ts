import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { flightsDriver, runConnector } from "@/lib/connectors";
import { clientSubject } from "@/lib/rate-limit";

/**
 * Server-side ADS-B proxy behind `/live/flights`, so the browser never sends its IP and
 * viewport to the upstream aggregator.
 *
 * Always returns the envelope so the client can show what's wrong and how old the data is.
 * Status is 200, except 429 when one of our own quotas refused the caller (matching
 * `/map/data/[slug]`). `disabled` and upstream `rate-limited` stay 200: waiting won't clear
 * the first, and the second isn't our limit.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  /** Quota subject: user id if signed in, else client IP. Hashed before storage. */
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

  /** `fetchedAt` is sent as ISO; the client computes the age on every tick. */
  /**
   * `Retry-After` from the limiter's reset instant, rounded up so the client doesn't arrive
   * just before the reset. Omitted when unknown (the limiter failed and we failed closed).
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
      /** Also in the body so the UI can show "try again at 08:26". Null unless refused. */
      quotaResetsAt: refused ? (envelope.quotaResetsAt?.toISOString() ?? null) : null,
      /** Which of our counters refused, so the UI doesn't have to infer it from `message`. */
      quotaScope: refused ? envelope.quotaScope : null,
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
