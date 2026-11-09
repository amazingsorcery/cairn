import { z } from "zod";

import { markdownSchema, slugSchema, uuidSchema } from "./common";
import { cameraViewKindSchema, confidenceSchema, connectorKindSchema } from "./vocabulary";
import { cameraSubjects, type CameraSubject } from "@/lib/content/schema";
import type { CameraViewKind } from "@/db/schema";

/**
 * Validation for `connectors` and `cameras`. Misconfiguration here is a legal exposure, so
 * these restate the many CHECK constraints with readable messages.
 */

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => v.startsWith("https://"), "Must be an https:// URL");

/** Editable connector fields. `slug` (referenced by drivers) and `kind` are fixed. */
export const updateConnectorSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(2).max(120),
    operatorName: z.string().trim().min(2).max(160),
    homepageUrl: httpsUrl,
    termsUrl: httpsUrl.nullable().default(null),
    attribution: z.string().trim().min(2).nullable().default(null),
    attributionRequired: z.boolean(),
    legalBasis: markdownSchema.nullable().default(null),
    baseUrl: httpsUrl,
    requiresApiKey: z.boolean(),
    /**
     * The env var name, never the credential. The `^[A-Z][A-Z0-9_]*$` pattern (also a DB
     * CHECK) rejects pasted keys.
     */
    apiKeyEnvVar: z
      .string()
      .trim()
      .regex(
        /^[A-Z][A-Z0-9_]*$/,
        "Name the environment variable (SCREAMING_SNAKE_CASE), never the key itself",
      )
      .nullable()
      .default(null),
    perUserQuota: z.number().int().positive(),
    globalCeiling: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    timeoutMs: z.number().int().positive().max(30_000),
    cacheTtlSeconds: z.number().int().min(0),
    staleWhileRevalidateSeconds: z.number().int().min(0),
    notes: z.string().trim().nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.attributionRequired && !c.attribution) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attribution"],
        message:
          "State the attribution this source requires. A nullable string cannot distinguish 'none required' from 'nobody filled this in'.",
      });
    }
    if (c.requiresApiKey && !c.apiKeyEnvVar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyEnvVar"],
        message: "A connector that needs a key must name the environment variable holding it.",
      });
    }
    if (c.globalCeiling < c.perUserQuota) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["globalCeiling"],
        message:
          "The global ceiling must be at least the per-user quota, or one user can exhaust the limit that protects the upstream from all of them.",
      });
    }
  });
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;

/**
 * Kill-switch. `enabled` is operational and independent of editorial `status`, so publishing
 * never re-enables a disabled connector.
 */
export const setConnectorEnabledSchema = z.object({
  id: uuidSchema,
  enabled: z.boolean(),
});
export type SetConnectorEnabledInput = z.infer<typeof setConnectorEnabledSchema>;

export const publishConnectorSchema = z
  .object({
    id: uuidSchema,
    termsUrl: z.string().nullable(),
    legalBasis: z.string().nullable(),
    lastCheckedAt: z.date().nullable(),
  })
  .superRefine((c, ctx) => {
    if (!c.termsUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["termsUrl"],
        message: "Record the licence or terms that permit our use before publishing.",
      });
    }
    if (!c.legalBasis) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["legalBasis"],
        message: "Record, in prose citing the clause, why we are permitted to call this source.",
      });
    }
    if (!c.lastCheckedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastCheckedAt"],
        message: "Confirm the endpoint works and the terms are unchanged before publishing.",
      });
    }
  });

export const connectorIdSchema = z.object({ id: uuidSchema });

/* ------------------------------------------------------------------ *
 * Cameras
 * ------------------------------------------------------------------ */

/**
 * Maps the five content camera subjects to the three DB view kinds. The `Record` type makes
 * a new subject a compile error.
 *
 *   weather -> traffic   road-weather cameras are highways infrastructure
 *   scenic  -> tourism
 */
export const CAMERA_SUBJECT_TO_VIEW_KIND: Readonly<Record<CameraSubject, CameraViewKind>> = {
  traffic: "traffic",
  transport: "transport",
  weather: "traffic",
  scenic: "tourism",
  tourism: "tourism",
};

/** Guard against the content vocabulary growing a member this map does not cover. */
export function assertCameraSubjectsMapped(): void {
  const unmapped = cameraSubjects.filter((s) => !(s in CAMERA_SUBJECT_TO_VIEW_KIND));
  if (unmapped.length > 0) {
    throw new Error(
      `Camera subjects with no view-kind mapping: [${unmapped.join(", ")}]. ` +
        "Extend CAMERA_SUBJECT_TO_VIEW_KIND in lib/validation/connectors.ts.",
    );
  }
}

export const updateCameraSchema = z
  .object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string().trim().min(1).max(160),
    operatorName: z.string().trim().min(2).max(160),
    connectorId: uuidSchema.nullable().default(null),
    jurisdiction: z.string().trim().min(2).max(40),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    locationLabel: z.string().trim().min(2).max(160),
    viewKind: cameraViewKindSchema,
    sourceUrl: httpsUrl,
    embedUrl: httpsUrl.nullable().default(null),
    embedPermitted: z.boolean(),
    /** Required to publish: why embedding is or isn't permitted. */
    embedNotes: z.string().trim().min(10).nullable().default(null),
    attribution: z.string().trim().min(2).nullable().default(null),
    confidence: confidenceSchema,
  })
  .superRefine((camera, ctx) => {
    if (camera.embedPermitted && !camera.embedUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedUrl"],
        message: "An embedded camera needs an embed URL.",
      });
    }
    if (!camera.embedPermitted && camera.embedUrl) {
      // Don't store a URL we may not load.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["embedUrl"],
        message: "Embedding is not permitted, so remove the embed URL.",
      });
    }
    if (camera.embedPermitted && !camera.connectorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectorId"],
        message:
          "Rendering a third party's feed inside our page relies on a permission, and a recorded permission lives on a connector.",
      });
    }
  });
export type UpdateCameraInput = z.infer<typeof updateCameraSchema>;

export const cameraIdSchema = z.object({ id: uuidSchema });

/** Re-export so the seed script has one import for the Live vocabularies. */
export { connectorKindSchema };
