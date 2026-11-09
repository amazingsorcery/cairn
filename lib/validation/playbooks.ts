import { z } from "zod";

import { markdownSchema, pastDateSchema, slugSchema, summarySchema, uuidSchema } from "./common";
import { confidenceSchema, difficultySchema } from "./vocabulary";

/**
 * Write-side validation for `playbooks` and `playbook_steps`. The database prevents duplicate
 * `order_index` values but not gaps; contiguity (0-based) is enforced here.
 */

const playbookBase = z.object({
  slug: slugSchema,
  title: z.string().trim().min(3).max(160),
  summary: summarySchema,
  overview: markdownSchema.nullable().default(null),
  categoryId: uuidSchema,
  difficulty: difficultySchema,
  /** Mirrors `playbooks_estimated_minutes_check`; capped at two days. */
  estimatedMinutes: z.number().int().positive().max(2880),
  confidence: confidenceSchema.default("needsReview"),
});

export const createPlaybookSchema = playbookBase;
export type CreatePlaybookInput = z.infer<typeof createPlaybookSchema>;

export const updatePlaybookSchema = playbookBase.extend({ id: uuidSchema });
export type UpdatePlaybookInput = z.infer<typeof updatePlaybookSchema>;

/**
 * Mirrors `playbooks_published_requires_verification_check`. Playbooks have no reliability
 * rating, so only the date is required.
 */
export const publishPlaybookSchema = z
  .object({ id: uuidSchema, lastVerifiedAt: pastDateSchema.nullable() })
  .superRefine((playbook, ctx) => {
    if (playbook.lastVerifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastVerifiedAt"],
        message:
          "Confirm the method still works before publishing. Nothing reaches the public catalogue without a verification date.",
      });
    }
  });
export type PublishPlaybookInput = z.infer<typeof publishPlaybookSchema>;

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

export const playbookStepSchema = z.object({
  /** 0-based. Contiguity is checked across the whole set, below. */
  orderIndex: z.number().int().min(0),
  title: z.string().trim().min(3).max(140),
  /** The step's objective, in one sentence. */
  objective: z.string().trim().min(10),
  body: markdownSchema,
  /** How you know the step is done. */
  doneWhen: z.string().trim().min(10),
  toolLinks: z
    .array(
      z.object({
        toolId: uuidSchema,
        note: z.string().trim().min(1).nullable().default(null),
        orderIndex: z.number().int().min(0).default(0),
      }),
    )
    .default([]),
});
export type PlaybookStepInput = z.infer<typeof playbookStepSchema>;

/**
 * Check 0-based contiguity. Exported so the seed script uses the same rule. Returns problems
 * instead of throwing.
 */
export function checkContiguousOrder(orderIndexes: readonly number[]): string[] {
  const problems: string[] = [];
  if (orderIndexes.length === 0) return problems;

  const sorted = [...orderIndexes].sort((a, b) => a - b);
  const expected = Array.from({ length: sorted.length }, (_, i) => i);

  if (sorted.join(",") !== expected.join(",")) {
    problems.push(
      `Step order must be 0..${sorted.length - 1} with no gaps and no duplicates, got [${sorted.join(", ")}]`,
    );
  }
  return problems;
}

const contiguous = <T extends { orderIndex: number }>(steps: readonly T[], ctx: z.RefinementCtx) => {
  for (const problem of checkContiguousOrder(steps.map((s) => s.orderIndex))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: problem });
  }
};

/** The whole step list, replaced atomically, since contiguity is a property of the set. */
export const replacePlaybookStepsSchema = z
  .object({
    playbookId: uuidSchema,
    steps: z.array(playbookStepSchema).min(2, "A playbook with fewer than two steps is a note"),
  })
  .superRefine((input, ctx) => contiguous(input.steps, ctx));
export type ReplacePlaybookStepsInput = z.infer<typeof replacePlaybookStepsSchema>;

/**
 * Drag-to-reorder: step ids in new order; the action derives indexes. Must run in one
 * transaction, relying on the `DEFERRABLE INITIALLY DEFERRED` unique constraint.
 */
export const reorderPlaybookStepsSchema = z
  .object({
    playbookId: uuidSchema,
    /** Step ids in their new order. Position in the array becomes `order_index`. */
    stepIds: z.array(uuidSchema).min(1),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.stepIds).size !== input.stepIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stepIds"],
        message: "The same step appears twice in the new order",
      });
    }
  });
export type ReorderPlaybookStepsInput = z.infer<typeof reorderPlaybookStepsSchema>;

export const reverifyPlaybookSchema = z.object({ id: uuidSchema });
export const playbookIdSchema = z.object({ id: uuidSchema });
