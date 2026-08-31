import { z } from "zod";

import { markdownSchema, slugSchema, uuidSchema } from "./common";
import { cameraViewKindSchema, confidenceSchema, connectorKindSchema } from "./vocabulary";
import { cameraSubjects, type CameraSubject } from "@/lib/content/schema";
import type { CameraViewKind } from "@/db/schema";

/**
 * Validation for the Live registry — `connectors` and `cameras`.
 *
 * These carry more CHECK constraints than any other table in the schema, and ADR 0012 says
 * why: "this is the only table in the schema whose misconfiguration is a legal exposure
 * rather than a bug". The Zod layer restates them so an operator gets a field and a
 * sentence; the constraints are what make it true from the seed script and from `psql`.
 */

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => v.startsWith("https://"), "Must be an https:// URL");

/**
 * Connector fields an admin may edit. `slug` and `kind` are not editable: the slug is
 * referenced by the driver in `lib/connectors/`, and changing the kind would repoint a
 * surface at an upstream that answers a different question.
 */
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
     * The NAME of the environment variable, never the credential.
     * `connectors_api_key_env_var_check` enforces `^[A-Z][A-Z0-9_]*$`, which no real API key
     * matches — the schema structurally refuses to become somewhere a secret can be pasted
     * (ADR 0012 §3). Restated here so the operator is told, not just refused.
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
          "State the attribution this source requires. A nullable string cannot distinguish 'none required' from 'nobody filled this in' (ADR 0012 §2).",
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
 * The kill-switch. ADR 0011 rule 6 and ADR 0012 §1: `enabled` is OPERATIONAL and separate
 * from `status`, which is EDITORIAL. An operator turning a connector off at 3am because its
 * terms changed must not have to touch editorial state, and re-publishing must not silently
 * re-enable something an operator switched off.
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
        message: "Record the licence or terms that permit our use before publishing (ADR 0011 rule 1).",
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
 * Content authors five camera SUBJECTS; the database constrains three VIEW KINDS.
 *
 * The two vocabularies answer slightly different questions and neither is wrong: content
 * describes what the camera points at, the schema describes which of the three browse
 * facets product-brief §2 names it belongs in. This map is the single place they meet, and
 * `Record<CameraSubject, CameraViewKind>` makes it exhaustive at compile time — a new
 * subject in `lib/content/schema.ts` becomes a type error here rather than a
 * `cameras_view_kind_check` violation half-way through a seed run.
 *
 *   weather -> traffic   a road-weather camera IS road infrastructure; it is published by a
 *                        highways authority and read for road conditions. Filing it under
 *                        "tourism" would be wrong and there is no "weather" facet.
 *   scenic  -> tourism   a mountain or harbour webcam is the tourism facet; "scenic" is the
 *                        editorial word for the same thing.
 *
 * If a fourth facet is ever wanted, extend CAMERA_VIEW_KINDS in `db/schema.ts` with a
 * CHECK-constraint migration and change this map in the same commit.
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
    /** Required to publish, in BOTH directions: state why embedding is or is not permitted. */
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
      // Storing a URL we are not permitted to load is how it eventually gets loaded.
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
          "Rendering a third party's feed inside our page relies on a permission, and a recorded permission lives on a connector (ADR 0012 §4).",
      });
    }
  });
export type UpdateCameraInput = z.infer<typeof updateCameraSchema>;

export const cameraIdSchema = z.object({ id: uuidSchema });

/** Re-export so the seed script has one import for the Live vocabularies. */
export { connectorKindSchema };
