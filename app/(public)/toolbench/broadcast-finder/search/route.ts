import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { broadcastDriver } from "@/lib/connectors/broadcast";
import { runConnector } from "@/lib/connectors/runtime";
import { clientSubject } from "@/lib/rate-limit";

/**
 * The station search behind `/toolbench/broadcast-finder`.
 *
 * ── WHY THIS IS A POST, WHEN IT IS A READ ──────────────────────────────────
 * A GET would put the reader's search terms — a country, a language, a station name — in
 * the query string, and a query string ends up in our own reverse proxy's access log. ADR
 * 0013 is explicit that we record THAT a request happened and never WHAT was asked for; a
 * log line reading `GET /toolbench/broadcast-finder/search?countrycode=UA&tag=news` would
 * undo that from the other side. The body of a POST is not logged.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 * The browser could query the Radio Browser API directly. It must not: that would hand a
 * third party the reader's IP address together with the place and language they are
 * searching for, which is the interest-graph leak product-brief §3.2 constraint 4 exists to
 * prevent, and ADR 0011 §1 puts every outbound call on a user's behalf on the server.
 *
 * ── WHAT IT DOES NOT PROXY ─────────────────────────────────────────────────
 * The audio. Stream URLs are returned to the browser, which connects to the broadcaster
 * directly (product-brief §2b). There is no route here that fetches one and there must
 * never be.
 *
 * ── WHICH REGISTRY ROW ─────────────────────────────────────────────────────
 * `runConnector` resolves it BY SLUG. It used to resolve by kind, and a kind now holds
 * several connectors; resolving by kind is how a driver ends up pointed at another source's
 * base URL with another source's quota. The row this uses is the existing `radio-browser`
 * one — the same operator, terms and kill-switch as the map layer, because it is the same
 * upstream.
 *
 * Always answers 200 with an envelope, even when the upstream is down: an HTTP error would
 * hand the client an error boundary and lose the reason, and the reason is what the reader
 * needs (ADR 0011 rule 5).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export async function POST(request: Request): Promise<Response> {
  /**
   * The quota subject: the signed-in user's id if there is one, otherwise the client IP.
   * Both are HMAC-hashed before they reach `rate_limits` or `connector_requests`, so
   * nothing identifying is stored on either side of the call (ADR 0009, ADR 0013).
   */
  const session = await auth();
  const subject = session?.user?.id ?? clientSubject(request);

  let raw: unknown = {};
  try {
    raw = (await request.json()) as unknown;
  } catch {
    // A malformed body is normalised into "no filters", which the driver's schema then
    // rejects or defaults. Nothing is thrown at the reader.
    raw = {};
  }

  const envelope = await runConnector(broadcastDriver, raw, { subject });

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
