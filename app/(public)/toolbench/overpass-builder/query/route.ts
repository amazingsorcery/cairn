import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { overpassDriver } from "@/lib/connectors/overpass";
import { runConnector } from "@/lib/connectors/runtime";
import { clientSubject } from "@/lib/rate-limit";

/**
 * The Overpass submission behind `/toolbench/overpass-builder`.
 *
 * ── POST, and the body is never logged ─────────────────────────────────────
 * The query contains a bounding box around the place a reader is investigating. That is the
 * single most sensitive thing this tool handles, and a GET would write it into our own
 * access log. ADR 0013: we record that a request happened, never what it asked for.
 *
 * ── WHY THE SERVER MAKES THE CALL ──────────────────────────────────────────
 * overpass-turbo runs in the browser, and for an OSM mapper that is right. For this audience
 * it is not: a direct browser call hands the Overpass operators the reader's IP address next
 * to the coordinates they are searching. ADR 0011 §1.
 *
 * ── THE QUERY IS NOT THE READER'S BYTES ────────────────────────────────────
 * `overpassDriver.normalise` runs the submitted text through the grammar in
 * `lib/toolbench/overpass.ts` and re-emits it from the parsed structure, so what reaches
 * the upstream is always a string this codebase generated. A query that does not parse is
 * refused here, no call is made, and no audit row is written — there was no outbound
 * attempt to record.
 *
 * ── WHICH REGISTRY ROW ─────────────────────────────────────────────────────
 * `runConnector` resolves it by `driver.slug`. It used to resolve by `driver.kind`, and
 * several connectors now share one kind — every Toolbench source is `infrastructure` — so it
 * handed this driver whichever row sorted first alphabetically. During development that
 * meant an Overpass query being POSTed at a DNS resolver's base URL, successfully, with the
 * wrong attribution and the wrong quota envelope. That is fixed in `runtime.ts` itself, and
 * the `runToolConnector` wrapper that worked around it has been deleted rather than left
 * behind as a second way to do the same thing.
 *
 * Always answers 200 with an envelope. The reader needs to know whether the query was
 * refused by us, refused by them, or ran and found nothing, and those are three different
 * sentences.
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
