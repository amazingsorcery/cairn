import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { broadcastDriver } from "@/lib/connectors/broadcast";
import { runConnector } from "@/lib/connectors/runtime";
import { clientSubject } from "@/lib/rate-limit";

/**
 * Station search for `/toolbench/broadcast-finder`.
 *
 * POST, not GET, so search terms stay out of the reverse proxy's access log. Server-side so
 * Radio Browser never sees the reader's IP with their query. Audio is not proxied; the
 * browser connects to broadcasters directly.
 *
 * `runConnector` resolves the `radio-browser` row by slug (shared with the map layer).
 * Always returns 200 with an envelope so the client gets the failure reason.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export async function POST(request: Request): Promise<Response> {
  /** Quota subject: user id, else client IP. Both are HMAC-hashed before storage. */
  const session = await auth();
  const subject = session?.user?.id ?? clientSubject(request);

  let raw: unknown = {};
  try {
    raw = (await request.json()) as unknown;
  } catch {
    // Malformed body becomes "no filters"; the driver's schema handles it.
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
