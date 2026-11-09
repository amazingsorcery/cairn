import { z } from "zod";

import { markdownSchema, slugSchema, uuidSchema } from "./common";

/**
 * Write-side validation for `categories` and `tags`. A rename must recompute `search_keywords`
 * on every tool carrying it, in the same transaction.
 */

export const createCategorySchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(80),
  description: markdownSchema.nullable().default(null),
  sortOrder: z.number().int().min(0).default(0),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.extend({ id: uuidSchema });
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/**
 * Reordering sends the whole list. Deleting a non-empty category fails with 23503
 * (`ON DELETE RESTRICT`), which the action turns into a readable message.
 */
export const reorderCategoriesSchema = z
  .object({ categoryIds: z.array(uuidSchema).min(1) })
  .superRefine((input, ctx) => {
    if (new Set(input.categoryIds).size !== input.categoryIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryIds"],
        message: "The same category appears twice in the new order",
      });
    }
  });
export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;

export const createTagSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(1).nullable().default(null),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = createTagSchema.extend({ id: uuidSchema });
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export const categoryIdSchema = z.object({ id: uuidSchema });
export const tagIdSchema = z.object({ id: uuidSchema });
