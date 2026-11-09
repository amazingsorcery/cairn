import { NextResponse } from "next/server";

import { findLayer, layerQuery, type MapViewport } from "@/components/map/registry";
import { clientSubject, consumeSafely } from "@/lib/rate-limit";
import { buildLayerPayload } from "../../payloads";

/**
 * `GET /map/data/<layer-id>`: one layer's payload for the client refresh.
 *
 * The browser never calls upstreams directly, which would leak the reader's IP and interests
 * and make a shared rate ceiling unenforceable. Uses the same `buildLayerPayload` as the page.
 *
 * SSRF: the slug is looked up in the registry, never interpolated, and the viewport is parsed
 * to four bounded numbers. Adapters build URLs from constants.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Viewport from the query string; invalid values fall back to the whole world.
 * Quantising happens once in `components/map/query.ts` so the cache key and the request agree.
 */
function readViewport(url: URL): MapViewport {
  const read = (key: string, limit: number): number | null => {
    const value = Number(url.searchParams.get(key));
    return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
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
    // 404 with a renderable payload, e.g. a layer removed since page load.
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

  /*
   * Per-client limit; this route is unauthenticated and middleware doesn't cover it.
   * Fails open on DB errors since it only protects our own server (connector quotas, which
   * protect third parties, fail closed).
   */
  const budget = await consumeSafely("map-layer", clientSubject(request));
  if (!budget.ok) {
    // `quotaExhausted` (we refused), not `rateLimited` (the upstream refused).
    return NextResponse.json(
      {
        layerId: layer.id,
        source: null,
        ok: false,
        failure: { kind: "quotaExhausted", resetsAt: budget.resetAt.toISOString() },
        lastGoodAt: null,
      },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(Math.max(1, Math.ceil((budget.resetAt.getTime() - Date.now()) / 1000))),
        },
      },
    );
  }

  const viewport = readViewport(new URL(request.url));
  const payload = await buildLayerPayload(layer, layerQuery(layer, viewport));

  return NextResponse.json(payload, {
    // The server-side cache already enforces cadence; an HTTP cache would add a second clock.
    headers: { "cache-control": "no-store" },
  });
}
