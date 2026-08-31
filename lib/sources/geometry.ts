import { z } from "zod";

import { coordinatePair } from "./adapter";

/**
 * The little GeoJSON we need, and nothing more.
 *
 * Several of these upstreams describe an *area* — a warning polygon, a forecast zone, a
 * disaster footprint — while `SourceFeature` is a point. Something has to choose the point,
 * and doing it here once means the choice is made the same way, and is testable, rather than
 * re-derived slightly differently in four adapters.
 */

/** A ring of `[longitude, latitude]` pairs, as GeoJSON orders them. */
const positionSchema = z.array(z.number()).min(2);

export const geometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: positionSchema }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(positionSchema)) }),
  z.object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(z.array(positionSchema))),
  }),
]);

export type SimpleGeometry = z.infer<typeof geometrySchema>;

/**
 * A representative point for a geometry.
 *
 * The **arithmetic mean of the outer ring's vertices**, not the area centroid. That is a
 * deliberate simplification and it has a limit worth stating: for a long thin polygon, or a
 * ring with unevenly spaced vertices, the vertex mean sits somewhere inside the general area
 * but is not the centre of mass. For placing a marker that a reader will click to open the
 * full alert text, that is fine. It would NOT be fine as a coordinate anyone measures from,
 * so adapters record the geometry type alongside it and the UI can say "approximate".
 *
 * Returns null when nothing renderable can be derived, so the caller drops the feature rather
 * than drawing it at null island.
 */
export function representativePoint(
  geometry: SimpleGeometry | null | undefined,
): { readonly longitude: number; readonly latitude: number } | null {
  if (!geometry) return null;

  if (geometry.type === "Point") {
    return coordinatePair(geometry.coordinates[0], geometry.coordinates[1]);
  }

  const ring =
    geometry.type === "Polygon"
      ? geometry.coordinates[0]
      : // MultiPolygon: the outer ring of the FIRST polygon. Averaging across disjoint
        // polygons would put the marker in the sea between two islands.
        geometry.coordinates[0]?.[0];
  if (!ring || ring.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const position of ring) {
    const point = coordinatePair(position[0], position[1]);
    if (!point) continue;
    sumLon += point.longitude;
    sumLat += point.latitude;
    count += 1;
  }
  if (count === 0) return null;

  return coordinatePair(sumLon / count, sumLat / count);
}
