import { serveMapLibreAsset } from "../serve";

/**
 * `GET /map/basemap-worker/maplibre-gl-shared.mjs`.
 *
 * The worker's very first statement is `import "./maplibre-gl-shared.mjs"`, resolved relative
 * to the worker's own URL — which is why this has to sit in the same directory as the worker
 * route and cannot be omitted.
 */

export const runtime = "nodejs";

export function GET(): Response {
  return serveMapLibreAsset("maplibre-gl-shared.mjs");
}
