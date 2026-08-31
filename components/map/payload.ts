import { z } from "zod";

import { SOURCE_KINDS } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * Zod at every boundary — including the boundary to our own route handler.
 *
 * The response from `/map/data/<slug>` is same-origin and ours, and "it is ours" is exactly
 * the assumption that stops being true after a refactor. Without a parse here, a shape
 * change turns into a blank map or a thrown render; with one, it turns into the layer's own
 * `schemaChanged` state, which is a designed screen with a sentence on it.
 *
 * This schema also pins the DTO to the `SourceAdapter` contract. If `lib/sources/types.ts`
 * gains a failure kind, `SourceFailure` in `registry/types.ts` widens, the exhaustive
 * `Record<SourceFailure["kind"], …>` maps in `layer-status.tsx` fail to compile, and this
 * union stops matching — three compile errors in the three places that need updating.
 */

const attributionSchema = z.object({
  text: z.string().min(1),
  href: z.string().url().optional(),
  licence: z.string().min(1),
});

const sourceSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  homepage: z.string().url(),
  attribution: attributionSchema,
  ttlSeconds: z.number().int().positive(),
});

const failureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upstreamError"),
    status: z.number().int().optional(),
    message: z.string(),
  }),
  z.object({ kind: z.literal("rateLimited"), retryAfterSeconds: z.number().int().optional() }),
  z.object({ kind: z.literal("schemaChanged"), message: z.string() }),
  z.object({ kind: z.literal("timeout"), afterMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("notConfigured"), missingEnvVar: z.string().min(1) }),
  z.object({ kind: z.literal("disabled"), reason: z.string().min(1) }),
]);

/**
 * A feature's property bag.
 *
 * `z.union` rather than `z.any()`: the contract types this as
 * `string | number | boolean | null`, and accepting an object here would let a nested
 * structure reach a table cell that can only render a scalar.
 */
const propertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const featureSchema = z.object({
  id: z.string().min(1),
  /* The contract's own union, imported rather than restated, so a new kind cannot
     silently fail to parse here after being added there. */
  kind: z.enum(SOURCE_KINDS),
  /* Bounds, not just types. An out-of-range coordinate silently draws a feature in the sea. */
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  altitude: z.number().optional(),
  label: z.string(),
  sourceUrl: z.string().url().optional(),
  properties: z.record(propertyValueSchema),
});

export const layerPayloadSchema = z.union([
  z.object({
    layerId: z.string().min(1),
    source: sourceSchema,
    ok: z.literal(true),
    features: z.array(featureSchema),
    observedAt: z.string().datetime(),
    stale: z.boolean(),
  }),
  z.object({
    layerId: z.string().min(1),
    source: sourceSchema.nullable(),
    ok: z.literal(false),
    failure: failureSchema,
    lastGoodAt: z.string().datetime().nullable(),
  }),
]);

/**
 * Parse a payload, or say why not.
 *
 * Returns a `schemaChanged` payload rather than throwing or returning null. A parse failure
 * is a real state with real copy — "we stopped reading it rather than guess at it" — and
 * routing it through the same union as every other failure means the one bad layer degrades
 * and the rest of the map does not notice.
 */
export function parseLayerPayload(value: unknown, layerId: string): LayerPayloadDto {
  const result = layerPayloadSchema.safeParse(value);
  if (result.success) return result.data;
  return {
    layerId,
    source: null,
    ok: false,
    failure: {
      kind: "schemaChanged",
      message: result.error.issues[0]?.message ?? "the response did not match the expected shape",
    },
    lastGoodAt: null,
  };
}
