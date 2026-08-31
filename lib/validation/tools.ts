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
 * Write-side validation for `tools`.
 *
 * The database already refuses a bad row (HANDOFF §3), and that is the enforcement of last
 * resort — the seed script, a migration and a hand-typed `psql` statement all bypass Zod.
 * What these schemas add is a violation the *editor* can act on: a named field and a
 * sentence, instead of a 23514 quoting a constraint name.
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
 * A draft may be half-finished. `lastVerifiedAt` and `reliability` are nullable precisely so
 * an editor can save work in progress — ADR 0007 §2.
 *
 * `lastVerifiedAt` and `status` are absent from this schema on purpose. A save must never
 * move a verification date (ADR 0007 §8: coupling them would let a typo fix silently assert
 * that every claim on the page was re-checked), and publication is its own action with its
 * own authorisation.
 */
export const createToolSchema = toolBase;
export type CreateToolInput = z.infer<typeof createToolSchema>;

export const updateToolSchema = toolBase.extend({ id: uuidSchema });
export type UpdateToolInput = z.infer<typeof updateToolSchema>;

/**
 * The publish gate, mirrored from `tools_published_requires_verification_check`.
 *
 * Checked here as well as in the database so the editor is told *which* field is missing.
 * The constraint is what makes it true; this is what makes it usable.
 */
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
          "Confirm the entry against its primary source before publishing. Nothing reaches the public catalogue without a verification date (ADR 0007).",
      });
    }
    if (tool.reliability === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reliability"],
        message: "Assign a reliability rating of 1–5 before publishing (ADR 0007).",
      });
    }
  });
export type PublishToolInput = z.infer<typeof publishToolSchema>;

/**
 * "Confirm still accurate" — the only action that moves `lastVerifiedAt` (ADR 0007 §8).
 * It takes no date from the caller: the date is `now()`, because the claim is that a human
 * looked *now*. Accepting a date would make back-dating a form field.
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
