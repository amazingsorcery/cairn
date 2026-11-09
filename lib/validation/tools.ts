import { z } from "zod";

import {
  catalogueUrlSchema,
  markdownSchema,
  pastDateSchema,
  reliabilitySchema,
  slugSchema,
  summarySchema,
  uuidSchema,
} from "./common";
import {
  confidenceSchema,
  costModelSchema,
  inputTypesSchema,
  outputTypesSchema,
  publicationStatusSchema,
} from "./vocabulary";

/**
 * Write-side validation for `tools`. The database constraints are the real enforcement;
 * these give editors a field name and message instead of a 23514.
 */

const toolBase = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  url: catalogueUrlSchema,
  summary: summarySchema,
  description: markdownSchema,
  categoryId: uuidSchema,
  inputTypes: inputTypesSchema,
  outputTypes: outputTypesSchema,
  costModel: costModelSchema,
  costNotes: z.string().trim().min(1).nullable().default(null),
  jurisdiction: z.string().trim().min(2).nullable().default(null),
  legalNotes: markdownSchema.nullable().default(null),
  reliability: reliabilitySchema.nullable().default(null),
  reliabilityNotes: z.string().trim().min(1).nullable().default(null),
  confidence: confidenceSchema.default("needsReview"),
  /** Tag ids, not slugs: the caller resolves slugs before it gets here. */
  tagIds: z.array(uuidSchema).max(12).default([]),
});

/**
 * Drafts may be incomplete, hence nullable `reliability`. `lastVerifiedAt` and `status` are
 * excluded: a save must not move the verification date, and publishing is a separate action.
 */
export const createToolSchema = toolBase;
export type CreateToolInput = z.infer<typeof createToolSchema>;

export const updateToolSchema = toolBase.extend({ id: uuidSchema });
export type UpdateToolInput = z.infer<typeof updateToolSchema>;

/** Publish gate, mirroring `tools_published_requires_verification_check` with field-level errors. */
export const publishToolSchema = z
  .object({
    id: uuidSchema,
    lastVerifiedAt: pastDateSchema.nullable(),
    reliability: reliabilitySchema.nullable(),
  })
  .superRefine((tool, ctx) => {
    if (tool.lastVerifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastVerifiedAt"],
        message:
          "Confirm the entry against its primary source before publishing. Nothing reaches the public catalogue without a verification date.",
      });
    }
    if (tool.reliability === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reliability"],
        message: "Assign a reliability rating of 1–5 before publishing.",
      });
    }
  });
export type PublishToolInput = z.infer<typeof publishToolSchema>;

/**
 * "Confirm still accurate": the only action that moves `lastVerifiedAt`. Takes no date; the
 * server uses `now()` so it can't be back-dated.
 */
export const reverifyToolSchema = z.object({ id: uuidSchema });
export type ReverifyToolInput = z.infer<typeof reverifyToolSchema>;

export const toolIdSchema = z.object({ id: uuidSchema });

/* ------------------------------------------------------------------ *
 * Playbook-independent read shapes
 * ------------------------------------------------------------------ */

export const toolSortSchema = z
  .enum(["relevance", "name", "recent", "reliability"])
  .catch("name");
export type ToolSort = z.infer<typeof toolSortSchema>;

export const toolStatusFilterSchema = publicationStatusSchema.optional();
