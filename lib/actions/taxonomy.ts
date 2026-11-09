"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";

import { categories, tags } from "@/db/schema";
import { requireAdmin, requireEditor } from "@/lib/auth";
import { db } from "@/lib/db";
import { TAG } from "@/lib/queries/cache";
import {
  categoryIdSchema,
  createCategorySchema,
  createTagSchema,
  reorderCategoriesSchema,
  tagIdSchema,
  updateCategorySchema,
  updateTagSchema,
} from "@/lib/validation/taxonomy";
import { fail, fromZodError, guard, ok, type ActionResult } from "./result";
import {
  playbookIdsForCategories,
  recomputePlaybookSearchKeywords,
  recomputeToolSearchKeywords,
  toolIdsForCategories,
  toolIdsForTags,
} from "./search-keywords";

/**
 * Taxonomy mutations (admin-only for categories). Category and tag names feed
 * `search_keywords`, so every rename recomputes affected rows in the same transaction;
 * otherwise search silently keeps the old name.
 */

export async function createCategory(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("category.create", async () => {
    await requireAdmin();

    const parsed = createCategorySchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const [row] = await db.insert(categories).values(parsed.data).returning({ id: categories.id });
    if (!row) throw new Error("Insert returned no category");

    revalidateTag(TAG.categories);
    revalidateTag(TAG.category(parsed.data.slug));
    revalidatePath("/directory");

    return ok({ id: row.id });
  });
}

/**
 * Update a category. A rename recomputes every tool and playbook in it (set-based, two
 * statements).
 */
export async function updateCategory(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("category.update", async () => {
    await requireAdmin();

    const parsed = updateCategorySchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, ...fields } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ slug: categories.slug, name: categories.name })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);

      if (!before) return null;

      const [row] = await tx
        .update(categories)
        .set(fields)
        .where(eq(categories.id, id))
        .returning({ id: categories.id, slug: categories.slug });

      if (!row) return null;

      // Same transaction as the rename.
      if (before.name !== fields.name) {
        await recomputeToolSearchKeywords(tx, await toolIdsForCategories(tx, [id]));
        await recomputePlaybookSearchKeywords(tx, await playbookIdsForCategories(tx, [id]));
      }

      return { id: row.id, oldSlug: before.slug, newSlug: row.slug };
    });

    if (!result) return fail("notFound", "That category does not exist.");

    revalidateTag(TAG.categories);
    revalidateTag(TAG.category(result.newSlug));
    // A slug change orphans the old category page's cache entry; purge it too.
    if (result.oldSlug !== result.newSlug) revalidateTag(TAG.category(result.oldSlug));
    revalidateTag(TAG.tools);
    revalidateTag(TAG.playbooks);
    revalidateTag(TAG.search);
    revalidatePath("/directory");

    return ok({ id: result.id });
  });
}

/**
 * Delete a category. `ON DELETE RESTRICT` blocks non-empty categories with a 23503, which
 * `guard` turns into a message.
 */
export async function deleteCategory(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("category.delete", async () => {
    await requireAdmin();

    const parsed = categoryIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const deleted = await db
      .delete(categories)
      .where(eq(categories.id, parsed.data.id))
      .returning({ id: categories.id, slug: categories.slug });

    const row = deleted[0];
    if (!row) return fail("notFound", "That category does not exist.");

    revalidateTag(TAG.categories);
    revalidateTag(TAG.category(row.slug));
    revalidateTag(TAG.tools);
    revalidateTag(TAG.playbooks);
    revalidatePath("/directory");

    return ok({ id: row.id });
  });
}

/** Reorder categories in one statement. No keyword fan-out needed. */
export async function reorderCategories(input: unknown): Promise<ActionResult<{ count: number }>> {
  return guard("category.reorder", async () => {
    await requireAdmin();

    const parsed = reorderCategoriesSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { categoryIds } = parsed.data;

    await db.execute(sql`
      update ${categories} c
      set sort_order = v.pos - 1
      from (select id, ordinality as pos
            from unnest(${sql.param(categoryIds)}::uuid[]) with ordinality as t(id, ordinality)) v
      where c.id = v.id
    `);

    revalidateTag(TAG.categories);
    revalidatePath("/directory");

    return ok({ count: categoryIds.length });
  });
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

export async function createTag(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tag.create", async () => {
    await requireEditor();

    const parsed = createTagSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const [row] = await db.insert(tags).values(parsed.data).returning({ id: tags.id });
    if (!row) throw new Error("Insert returned no tag");

    revalidateTag(TAG.tags);
    revalidateTag(TAG.tag(parsed.data.slug));
    revalidatePath("/directory");

    return ok({ id: row.id });
  });
}

/** Update a tag. A rename recomputes `search_keywords` on every tool carrying it. */
export async function updateTag(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tag.update", async () => {
    await requireEditor();

    const parsed = updateTagSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, ...fields } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ slug: tags.slug, name: tags.name })
        .from(tags)
        .where(eq(tags.id, id))
        .limit(1);

      if (!before) return null;

      const [row] = await tx
        .update(tags)
        .set(fields)
        .where(eq(tags.id, id))
        .returning({ id: tags.id, slug: tags.slug });

      if (!row) return null;

      let affectedTools: string[] = [];
      if (before.name !== fields.name) {
        affectedTools = await toolIdsForTags(tx, [id]);
        await recomputeToolSearchKeywords(tx, affectedTools);
      }

      return { id: row.id, oldSlug: before.slug, newSlug: row.slug, affectedTools };
    });

    if (!result) return fail("notFound", "That tag does not exist.");

    revalidateTag(TAG.tags);
    revalidateTag(TAG.tag(result.newSlug));
    if (result.oldSlug !== result.newSlug) revalidateTag(TAG.tag(result.oldSlug));
    revalidateTag(TAG.tools);
    revalidateTag(TAG.search);
    revalidatePath("/directory");

    return ok({ id: result.id });
  });
}

/**
 * Delete a tag. `tool_tags` cascades; affected tools are collected first and recomputed after
 * so their keywords drop the old name.
 */
export async function deleteTag(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tag.delete", async () => {
    await requireEditor();

    const parsed = tagIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ id: tags.id, slug: tags.slug })
        .from(tags)
        .where(eq(tags.id, parsed.data.id))
        .limit(1);

      if (!before) return null;

      // Before the cascade removes the `tool_tags` rows.
      const affectedTools = await toolIdsForTags(tx, [before.id]);

      await tx.delete(tags).where(eq(tags.id, before.id));

      await recomputeToolSearchKeywords(tx, affectedTools);
      return { id: before.id, slug: before.slug };
    });

    if (!result) return fail("notFound", "That tag does not exist.");

    revalidateTag(TAG.tags);
    revalidateTag(TAG.tag(result.slug));
    revalidateTag(TAG.tools);
    revalidateTag(TAG.search);
    revalidatePath("/directory");

    return ok({ id: result.id });
  });
}
