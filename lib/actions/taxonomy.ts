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
 * Taxonomy mutations. `/admin/taxonomy` is admin-only (sitemap.md §8).
 *
 * THIS IS THE FILE WHERE THE FAN-OUT MATTERS MOST, and where getting it wrong is completely
 * silent. A category or tag NAME is part of every affected row's `search_keywords`
 * (search.md §3), which feeds the generated `search_vector`. Rename a tag without
 * recomputing and:
 *
 *   - the tool is still findable by the OLD tag name, which no longer exists anywhere;
 *   - the tool is NOT findable by the new one;
 *   - nothing errors, no page breaks, and no test that does not search for the new name
 *     will notice.
 *
 * HANDOFF §11 assertion 6 exists precisely for this. Every rename below recomputes in the
 * SAME TRANSACTION as the rename.
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
 * Rename or re-describe a category.
 *
 * The rename fans out to EVERY tool AND EVERY playbook in the category — both tables carry
 * the category name in `search_keywords` (HANDOFF §4). Both recomputes are set-based
 * `UPDATE … FROM` statements, so a category with two hundred tools is two statements, not
 * two hundred.
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

      // Same transaction as the rename. HANDOFF §4, search.md §3.
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
 * Delete a category.
 *
 * `tools.category_id` and `playbooks.category_id` are `ON DELETE RESTRICT`, so a category
 * with content in it cannot be deleted. That produces a 23503, which `guard` turns into a
 * readable sentence. The restrict is correct: a category is a required field on both
 * tables, so cascading would delete content and setting null is not possible.
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

/**
 * Reorder categories. ONE statement — `unnest … WITH ORDINALITY` joined against the table.
 * No fan-out: `sort_order` is not part of `search_keywords`.
 */
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

/**
 * Rename a tag — HANDOFF §11 assertion 6, the fan-out that is easiest to forget.
 *
 * "Renaming a tag updates `search_keywords` on every tool carrying it, and the tool is still
 * findable by the new tag name." The tool ids are collected and recomputed inside the same
 * transaction as the rename, so search can never observe a tag name that no tool's keywords
 * contain.
 */
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
 * Delete a tag. `tool_tags` cascades, so the tools survive — but their `search_keywords`
 * still contain the deleted tag's name until recomputed, which would keep them findable by a
 * tag that no longer exists. Collected before the delete, recomputed after, one transaction.
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

      // Collected BEFORE the cascade removes the `tool_tags` rows that identify them.
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
