import type { SourceQuery } from "@/lib/sources/types";

/**
 * Source query normalisation shared by the server payload cache (`sources.ts`) and the
 * client throttle (`map-surface.tsx`), so both agree on whether two viewports are the same
 * question. Client-safe: no server-only imports.
 *
 * The cache key must include the query; keyed on slug alone, one reader's viewport would be
 * served to everyone.
 *
 * Grid is 1° (~111 km): coarse enough that nearby readers share a cache entry and upstreams
 * see a coarse coordinate, finer than adsb.lol's 250 nm radius. Rounds outward so the
 * normalised box always contains the requested one; nearest-rounding can collapse a small
 * viewport to zero area.
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
 * The query as sent to the adapter and keyed in the cache. `loadSource` uses one result for
 * both so they can't diverge.
 */
export function normaliseSourceQuery(query: SourceQuery): SourceQuery {
  const limit = query.limit === undefined ? {} : { limit: query.limit };
  const bbox = query.bbox;
  if (!bbox) return limit;

  const edges = [bbox.west, bbox.south, bbox.east, bbox.north];
  /*
   * Drop an unreadable box rather than repair it; no bbox means the whole feed or the
   * source's configured area. The route also drops non-finite params.
   */
  if (!edges.every((edge) => Number.isFinite(edge))) return limit;

  const west = clamp(snap(bbox.west, "down"), -180, 180);
  const south = clamp(snap(bbox.south, "down"), -90, 90);
  const east = clamp(snap(bbox.east, "up"), -180, 180);
  const north = clamp(snap(bbox.north, "up"), -90, 90);

  /*
   * Only an inverted or zero-area input fails this after outward snapping (e.g. across the
   * antimeridian, which the aircraft layer's `query` already maps to `{}`).
   */
  if (east <= west || north <= south) return limit;

  return { ...limit, bbox: { west, south, east, north } };
}

/**
 * The cache key for one query, normalised. Same shape as `lib/connectors/runtime.ts`'s
 * `${connector.slug}:${driver.cacheKey(params)}` — the caller prepends the slug.
 *
 * `unscoped` means no bbox was asked for (the configured area, or the whole feed).
 */
export function sourceQueryKey(query: SourceQuery): string {
  const normalised = normaliseSourceQuery(query);
  const box = normalised.bbox;
  const area = box ? `${box.west},${box.south},${box.east},${box.north}` : "unscoped";
  return normalised.limit === undefined ? area : `${area}|limit=${normalised.limit}`;
}
