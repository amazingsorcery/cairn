import { z } from "zod";

import { markdownSchema, pastDateSchema, slugSchema, summarySchema, uuidSchema } from "./common";
import { confidenceSchema, difficultySchema } from "./vocabulary";

/**
 * Write-side validation for `playbooks` and `playbook_steps`.
 *
 * The invariant the database does NOT enforce and this file does: `order_index` is 0-based
 * and CONTIGUOUS within a playbook (HANDOFF §3). The hand-written migration adds a
 * DEFERRABLE unique constraint on `(playbook_id, order_index)`, which stops duplicates but
 * says nothing about gaps — `[0, 1, 3]` satisfies uniqueness and renders as a playbook whose
 * step numbering skips 3.
 */

const playbookBase = z.object({
  slug: slugSchema,
  title: z.string().trim().min(3).max(160),
  summary: summarySchema,
  overview: markdownSchema.nullable().default(null),
  categoryId: uuidSchema,
  difficulty: difficultySchema,
  /** Mirrors `playbooks_estimated_minutes_check`. Two days is a generous upper sanity bound. */
  estimatedMinutes: z.number().int().positive().max(2880),
  confidence: confidenceSchema.default("needsReview"),
});

export const createPlaybookSchema = playbookBase;
export type CreatePlaybookInput = z.infer<typeof createPlaybookSchema>;

export const updatePlaybookSchema = playbookBase.extend({ id: uuidSchema });
export type UpdatePlaybookInput = z.infer<typeof updatePlaybookSchema>;

/**
 * `publishPlaybookSchema` mirrors `playbooks_published_requires_verification_check`.
 * Playbooks carry no reliability rating (data-model.md §6), so the gate is the date alone.
 */
export const publishPlaybookSchema = z
  .object({ id: uuidSchema, lastVerifiedAt: pastDateSchema.nullable() })
  .superRefine((playbook, ctx) => {
    if (playbook.lastVerifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastVerifiedAt"],
        message:
          "Confirm the method still works before publishing. Nothing reaches the public catalogue without a verification date (ADR 0007).",
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
  /** product-brief §2: each step "states its objective". One sentence. */
  objective: z.string().trim().min(10),
  body: markdownSchema,
  /** product-brief §2: each step "states how you know the step is done". */
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
 * Assert 0-based contiguity. Split out from the schema so the seed script's 1-based → 0-based
 * translation can be tested against the identical rule the admin path uses.
 *
 * Returns a list of problems rather than throwing, so a caller can attach them to fields.
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

/**
 * The whole step list for a playbook, replaced atomically. Steps are not edited one at a
 * time: contiguity is a property of the set, so validating a single step in isolation cannot
 * express it, and a partial write would leave a gap.
 */
export const replacePlaybookStepsSchema = z
  .object({
    playbookId: uuidSchema,
    steps: z.array(playbookStepSchema).min(2, "A playbook with fewer than two steps is a note"),
  })
  .superRefine((input, ctx) => contiguous(input.steps, ctx));
export type ReplacePlaybookStepsInput = z.infer<typeof replacePlaybookStepsSchema>;

/**
 * Drag-to-reorder. Sends the step ids in their new order; the action derives the indexes,
 * so a client cannot invent one.
 *
 * This runs inside ONE transaction: swapping two indexes transiently duplicates a value, and
 * only `DEFERRABLE INITIALLY DEFERRED` (HANDOFF §6) makes that legal until commit.
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
