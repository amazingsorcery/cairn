import { z } from "zod";

import { SOURCE_KINDS } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * Zod schema for `/map/data/<slug>` responses. Even though it's our own route, a shape change
 * should become the layer's `schemaChanged` state rather than a blank map or thrown render.
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
  /* `resetsAt` arrives as a JSON string; coerce it back to a `Date`. */
  z.object({ kind: z.literal("quotaExhausted"), resetsAt: z.coerce.date().optional() }),
  /* No fields: the destination host is upstream-controlled and stays in the server log. */
  z.object({ kind: z.literal("redirected") }),
  z.object({ kind: z.literal("schemaChanged"), message: z.string() }),
  z.object({ kind: z.literal("timeout"), afterMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("notConfigured"), missingEnvVar: z.string().min(1) }),
  z.object({ kind: z.literal("disabled"), reason: z.string().min(1) }),
]);

/** Every failure kind, derived from the union above so tests can't fall out of sync. */
export const FAILURE_KINDS: readonly SourceFailureKind[] = failureSchema.options.map(
  (option) => option.shape.kind.value,
);

/** The kinds this schema accepts. Identical to `SourceFailure["kind"]`; asserted in the test. */
export type SourceFailureKind = z.infer<typeof failureSchema>["kind"];

/** A feature property: scalars only, since table cells can't render nested objects. */
const propertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * Position caveat. Must be listed: `z.object` strips unknown keys, so it would otherwise
 * vanish on the first client refresh.
 */
const precisionSchema = z.object({
  label: z.string().min(1),
  note: z.string().min(1),
  approximateRadiusMetres: z.number().nonnegative().optional(),
});

const featureSchema = z.object({
  id: z.string().min(1),
  /* Imported from the contract so new kinds parse automatically. */
  kind: z.enum(SOURCE_KINDS),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  altitude: z.number().optional(),
  label: z.string(),
  sourceUrl: z.string().url().optional(),
  precision: precisionSchema.nullish(),
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

/** Parse a payload; on failure return a `schemaChanged` payload so only that layer degrades. */
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
