import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { overpassDriver } from "@/lib/connectors/overpass";
import { runConnector } from "@/lib/connectors/runtime";
import { clientSubject } from "@/lib/rate-limit";

/**
 * Overpass submission for `/toolbench/overpass-builder`.
 *
 * POST so the bounding box stays out of the access log. Server-side so Overpass never sees
 * the reader's IP next to their coordinates.
 *
 * `overpassDriver.normalise` parses the query with `lib/toolbench/overpass.ts` and re-emits
 * it, so the upstream only ever gets a string we generated. Unparseable queries are refused
 * with no call and no audit row. `runConnector` resolves the registry row by `driver.slug`.
 *
 * Always returns 200 with an envelope so the client can tell our refusal, theirs, and an
 * empty result apart.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex",
} as const;

export async function POST(request: Request): Promise<Response> {
  const session = await auth();
  const subject = session?.user?.id ?? clientSubject(request);

  let raw: unknown = {};
  try {
    raw = (await request.json()) as unknown;
  } catch {
    raw = {};
  }

  const envelope = await runConnector(overpassDriver, raw, { subject });

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
