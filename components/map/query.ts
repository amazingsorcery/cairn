import type { SourceQuery } from "@/lib/sources/types";

/**
 * ONE NORMALISATION OF A SOURCE QUERY, SHARED BY THE SERVER CACHE AND THE CLIENT THROTTLE.
 *
 * ## What went wrong without it (QA finding QV-04)
 *
 * `app/(public)/map/sources.ts` keyed its payload cache on the adapter slug alone while the
 * aircraft layer is viewport-scoped, so a reader who opened `/map` inside one TTL of somebody
 * else zooming into Tokyo was handed Tokyo's 58 aircraft as the answer for Europe — captioned
 * with a real observation instant, announced by the live region, and marked `fresh`, because
 * the cache believed it had answered this question. There is no fixed size to that error: it
 * is whatever the previous reader happened to be looking at. On a surface whose table is the
 * *required equivalent* rather than a fallback, that is the accessible path lying with
 * confidence.
 *
 * The key now includes the query. That fix alone would have made every pan a distinct entry
 * and a cold miss, so the client's `moveend` re-fetch is throttled in the same change — and
 * the throttle needs to answer "would the request I would send now be the same request that
 * produced the payload I am holding?" That is exactly what the cache key answers, so the two
 * must be computed by the same function or they will drift, which is the original defect one
 * level up.
 *
 * This module is therefore deliberately client-safe: no `server-only`, no database, no
 * adapter imports. `map-surface.tsx` calls it in the browser and `sources.ts` calls it in the
 * request path, and neither has its own copy of the grid.
 *
 * ## Why the grid is coarse, and why it rounds outward
 *
 * ADR 0014 §4: many readers looking at roughly the same place should share one upstream call
 * and one cache entry, and the coordinate we hand an upstream should be coarser than the one
 * the reader is looking at. A whole degree is ~111 km — smaller than the 250 nm circle
 * adsb.lol answers with, so two viewports a cell apart really are different questions, and
 * float noise from a map's `getBounds()` cannot make the cache useless.
 *
 * Rounding is **outward** (floor the south-west corner, ceil the north-east) rather than to
 * the nearest degree, for one reason that matters: the normalised box always *contains* the
 * box that was asked for. Nearest-rounding shrinks a viewport, and a viewport narrower than
 * one degree on both axes collapses to a zero-area box — which `viewportFromBbox` turns into
 * a 1 nm circle and the layer renders as an honest-looking empty table. Silent incompleteness
 * is the failure this codebase keeps meeting; the normalisation must not be able to cause it.
 */

/** Degrees. The cell size of the grid every bbox is snapped to before it reaches a source. */
export const QUERY_GRID_DEGREES = 1;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Snap outward to the grid: `floor` for a lower edge, `ceil` for an upper one. */
function snap(value: number, direction: "down" | "up"): number {
  const cells = value / QUERY_GRID_DEGREES;
  const snapped = direction === "down" ? Math.floor(cells) : Math.ceil(cells);
  /* `+ 0` normalises `-0` to `0`, so two identical boxes cannot produce two keys. */
  return snapped * QUERY_GRID_DEGREES + 0;
}

/**
 * The query as it will actually be sent to the adapter **and** keyed in the cache.
 *
 * Called once, in `loadSource`, and its result is used for both — so it is structurally
 * impossible for the cache to be keyed on a finer or coarser question than the one the
 * upstream was asked. That equality is the whole point; the two diverging is QV-04.
 */
export function normaliseSourceQuery(query: SourceQuery): SourceQuery {
  const limit = query.limit === undefined ? {} : { limit: query.limit };
  const bbox = query.bbox;
  if (!bbox) return limit;

  const edges = [bbox.west, bbox.south, bbox.east, bbox.north];
  /*
   * An unreadable box is dropped rather than repaired. `SourceQuery` with no bbox is
   * documented as "the whole feed, or the source's configured area" — a defined state each
   * adapter already handles — whereas a guessed-at rectangle would be us inventing the
   * question. The route drops non-finite parameters too, so this is defence in depth.
   */
  if (!edges.every((edge) => Number.isFinite(edge))) return limit;

  const west = clamp(snap(bbox.west, "down"), -180, 180);
  const south = clamp(snap(bbox.south, "down"), -90, 90);
  const east = clamp(snap(bbox.east, "up"), -180, 180);
  const north = clamp(snap(bbox.north, "up"), -90, 90);

  /*
   * Outward snapping cannot degenerate a properly ordered box, so failing this test means the
   * box arrived inverted — a viewport spanning the antimeridian, or a zero-area point. Neither
   * is a rectangle this pipeline can answer, and inventing an interpretation would put a
   * fabricated area in front of a reader. (A viewport that genuinely crosses the antimeridian
   * spans more than 180°, and the aircraft layer's own `query` already returns `{}` for that.)
   */
  if (east <= west || north <= south) return limit;

  return { ...limit, bbox: { west, south, east, north } };
}

/**
 * The cache key for one query, normalised. Same shape as `lib/connectors/runtime.ts`'s
 * `${connector.slug}:${driver.cacheKey(params)}` — the caller prepends the slug.
 *
 * `unscoped` is not "the world": for a source with a configured area it means that area, and
 * for a global feed it means the whole feed. What it always means is "no bounding box was
 * asked for", which is the thing the key has to distinguish.
 */
export function sourceQueryKey(query: SourceQuery): string {
  const normalised = normaliseSourceQuery(query);
  const box = normalised.bbox;
  const area = box ? `${box.west},${box.south},${box.east},${box.north}` : "unscoped";
  return normalised.limit === undefined ? area : `${area}|limit=${normalised.limit}`;
}
