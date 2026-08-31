import { NextResponse } from "next/server";

import { findLayer, layerQuery, type MapViewport } from "@/components/map/registry";
import { buildLayerPayload } from "../../payloads";

/**
 * `GET /map/data/<layer-id>` — one layer's current payload, for the client's refresh tick.
 *
 * ## Why the browser talks to us and never to the upstream
 *
 * A client-side fetch straight to a source hands that source the reader's IP address and,
 * layer by layer, the pattern of what they are watching. For an audience of journalists and
 * human-rights researchers that is the interest graph this product exists not to leak
 * (ADR 0011 §1, product-brief §3.2). It also makes a shared rate ceiling unenforceable: with
 * every browser calling directly there is nothing to count.
 *
 * So every refresh comes here, and here goes through the same `buildLayerPayload` the page
 * uses — same cache entry, same TTL, same failure kinds. One code path, one clock.
 *
 * ## The slug is looked up, never interpolated
 *
 * `findLayer` resolves against the registry, and an unknown id returns a `disabled` payload
 * rather than an error page or, worse, a URL built from user input. Nothing from the request
 * reaches an outbound URL as text: the viewport below is parsed to four bounded numbers and
 * the adapter builds its own URL from constants. That is the SSRF shape ADR 0019 flags as
 * v2's top risk, closed by construction rather than by validation.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The viewport, from the query string, or the whole world.
 *
 * Anything that fails validation is DROPPED rather than rejected: a crafted query string must
 * not be able to render an error page, and the fallback is a correct answer rather than an
 * empty one. The numbers are also quantised to whole degrees before they reach a source —
 * many readers looking at roughly the same place then share one upstream call and one cache
 * entry (ADR 0014 §4), and the coordinate we hand an upstream is deliberately coarser than
 * the one the reader is looking at.
 */
function readViewport(url: URL): MapViewport {
  const read = (key: string, limit: number): number | null => {
    const value = Number(url.searchParams.get(key));
    return Number.isFinite(value) && Math.abs(value) <= limit ? Math.round(value) : null;
  };
  const west = read("w", 180);
  const south = read("s", 90);
  const east = read("e", 180);
  const north = read("n", 90);
  if (west === null || south === null || east === null || north === null) {
    return { west: -180, south: -85, east: 180, north: 85 };
  }
  return { west, south, east, north };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const layer = findLayer(slug);

  if (!layer) {
    /*
     * 404 with a payload the client can render, not an empty body. A stale bookmark or a
     * layer removed from the registry between page load and refresh must produce a state
     * with a sentence on it, not a blank row.
     */
    return NextResponse.json(
      {
        layerId: slug,
        source: null,
        ok: false,
        failure: { kind: "disabled", reason: "this layer is no longer on the map." },
        lastGoodAt: null,
      },
      { status: 404 },
    );
  }

  const viewport = readViewport(new URL(request.url));
  const payload = await buildLayerPayload(layer, layerQuery(layer, viewport));

  return NextResponse.json(payload, {
    /*
     * No shared HTTP cache in front of this. The payload's own age is inside it and the
     * server-side cache already enforces the source's cadence; a second cache with its own
     * clock is the two-clocks problem ADR 0014 §5 rejects.
     */
    headers: { "cache-control": "no-store" },
  });
}
