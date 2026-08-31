import { serveMapLibreAsset } from "../serve";

/**
 * `GET /map/basemap-worker/maplibre-gl-worker.mjs`. See `../serve.ts` for why this route
 * exists at all — the short version is that MapLibre cannot find its own worker under a
 * bundler, and the failure is a silently blank basemap rather than an error.
 */

export const runtime = "nodejs";

export function GET(): Response {
  return serveMapLibreAsset("maplibre-gl-worker.mjs");
}
