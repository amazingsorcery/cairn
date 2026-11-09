"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, inArray } from "drizzle-orm";

import { categories, toolTags, tools } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { db } from "@/lib/db";
import { TAG } from "@/lib/queries/cache";
import {
  createToolSchema,
  publishToolSchema,
  reverifyToolSchema,
  toolIdSchema,
  updateToolSchema,
} from "@/lib/validation/tools";
import { fail, fromZodError, guard, ok, type ActionResult } from "./result";
import {
  playbookSlugsCitingTools,
  recomputeToolSearchKeywords,
  tagSlugsForTool,
} from "./search-keywords";

/**
 * Editorial mutations on `tools` (`editor` or `admin`).
 *
 * 1. `search_keywords` is recomputed in the same transaction as any category/tag/facet change.
 * 2. Revalidation runs after commit, never inside the transaction.
 * 3. Draft edits purge nothing; drafts aren't on public pages.
 */

/** The tag set for a tool mutation, assembled once so publish and delete cannot diverge. */
function toolTags_(slug: string, categorySlug: string, tagSlugs: readonly string[]): string[] {
  return [
    TAG.tools,
    TAG.tool(slug),
    TAG.category(categorySlug),
    ...tagSlugs.map((t) => TAG.tag(t)),
    TAG.search,
  ];
}

export async function createTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.create", async () => {
    const user = await requireEditor();

    const parsed = createToolSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { tagIds, ...fields } = parsed.data;

    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tools)
        .values({ ...fields, updatedById: user.id })
        .returning({ id: tools.id });

      if (!row) throw new Error("Insert returned no tool");

      if (tagIds.length > 0) {
        await tx.insert(toolTags).values(tagIds.map((tagId) => ({ toolId: row.id, tagId })));
      }

      // Same transaction as the insert.
      await recomputeToolSearchKeywords(tx, [row.id]);
      return row.id;
    });

    // No revalidation: a new tool is a draft, and a draft is on no public page.
    return ok({ id });
  });
}

export async function updateTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.update", async () => {
    const user = await requireEditor();

    const parsed = updateToolSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, tagIds, ...fields } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(tools)
        // No `last_verified_at`: only `reverifyTool` moves it.
        .set({ ...fields, updatedById: user.id })
        .where(eq(tools.id, id))
        .returning({ id: tools.id, slug: tools.slug, status: tools.status });

      if (!row) return null;

      // Replace the tag set wholesale.
      await tx.delete(toolTags).where(eq(toolTags.toolId, id));
      if (tagIds.length > 0) {
        await tx.insert(toolTags).values(tagIds.map((tagId) => ({ toolId: id, tagId })));
      }

      await recomputeToolSearchKeywords(tx, [id]);

      const [category] = await tx
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.id, fields.categoryId))
        .limit(1);

      const tagSlugs = await tagSlugsForTool(tx, id);
      return { ...row, categorySlug: category?.slug ?? null, tagSlugs };
    });

    if (!result) return fail("notFound", "That tool does not exist.");

    // Only published tools have cache entries to purge.
    if (result.status === "published" && result.categorySlug) {
      for (const tag of toolTags_(result.slug, result.categorySlug, result.tagSlugs)) {
        revalidateTag(tag);
      }
    }

    return ok({ id: result.id });
  });
}

/**
 * Publish. The DB constraint enforces the gate; Zod names the missing field.
 * `published_at` is set on first publish and never cleared, since it drives "recently added".
 */
export async function publishTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.publish", async () => {
    const user = await requireEditor();

    const parsed = toolIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: tools.id,
          slug: tools.slug,
          categoryId: tools.categoryId,
          lastVerifiedAt: tools.lastVerifiedAt,
          reliability: tools.reliability,
          publishedAt: tools.publishedAt,
        })
        .from(tools)
        .where(eq(tools.id, parsed.data.id))
        .limit(1);

      if (!current) return { kind: "notFound" as const };

      const gate = publishToolSchema.safeParse({
        id: current.id,
        lastVerifiedAt: current.lastVerifiedAt,
        reliability: current.reliability,
      });
      if (!gate.success) return { kind: "gate" as const, error: gate.error };

      await tx
        .update(tools)
        .set({
          status: "published",
          publishedAt: current.publishedAt ?? new Date(),
          updatedById: user.id,
        })
        .where(eq(tools.id, current.id));

      const [category] = await tx
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.id, current.categoryId))
        .limit(1);

      return {
        kind: "ok" as const,
        id: current.id,
        slug: current.slug,
        categorySlug: category?.slug ?? null,
        tagSlugs: await tagSlugsForTool(tx, current.id),
      };
    });

    if (result.kind === "notFound") return fail("notFound", "That tool does not exist.");
    if (result.kind === "gate") return fromZodError(result.error);

    if (result.categorySlug) {
      for (const tag of toolTags_(result.slug, result.categorySlug, result.tagSlugs)) {
        revalidateTag(tag);
      }
    }
    // Also purge the two highest-traffic listing paths.
    revalidatePath("/directory");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

export async function unpublishTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.unpublish", async () => {
    const user = await requireEditor();

    const parsed = toolIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(tools)
        // `published_at` is not cleared.
        .set({ status: "draft", updatedById: user.id })
        .where(eq(tools.id, parsed.data.id))
        .returning({ id: tools.id, slug: tools.slug, categoryId: tools.categoryId });

      if (!row) return null;

      const [category] = await tx
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.id, row.categoryId))
        .limit(1);

      return { ...row, categorySlug: category?.slug ?? null, tagSlugs: await tagSlugsForTool(tx, row.id) };
    });

    if (!result) return fail("notFound", "That tool does not exist.");

    if (result.categorySlug) {
      for (const tag of toolTags_(result.slug, result.categorySlug, result.tagSlugs)) {
        revalidateTag(tag);
      }
    }
    revalidatePath("/directory");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

/**
 * Delete. Playbook pages render linked tools, so citing playbook slugs are collected before
 * the cascade removes `playbook_step_tools`. `workspace_items` keep their title and get a
 * null `tool_id` (`ON DELETE SET NULL`).
 */
export async function deleteTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.delete", async () => {
    await requireEditor();

    const parsed = toolIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: tools.id, slug: tools.slug, categoryId: tools.categoryId })
        .from(tools)
        .where(eq(tools.id, parsed.data.id))
        .limit(1);

      if (!current) return null;

      // Collected BEFORE the cascade removes the link rows.
      const affectedPlaybookSlugs = await playbookSlugsCitingTools(tx, [current.id]);
      const tagSlugs = await tagSlugsForTool(tx, current.id);

      const [category] = await tx
        .select({ slug: categories.slug })
        .from(categories)
        .where(eq(categories.id, current.categoryId))
        .limit(1);

      await tx.delete(tools).where(eq(tools.id, current.id));

      return {
        id: current.id,
        slug: current.slug,
        categorySlug: category?.slug ?? null,
        tagSlugs,
        affectedPlaybookSlugs,
      };
    });

    if (!result) return fail("notFound", "That tool does not exist.");

    if (result.categorySlug) {
      for (const tag of toolTags_(result.slug, result.categorySlug, result.tagSlugs)) {
        revalidateTag(tag);
      }
    }
    revalidateTag(TAG.playbooks);
    for (const slug of result.affectedPlaybookSlugs) revalidateTag(TAG.playbook(slug));
    revalidatePath("/directory");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

/**
 * "Confirm still accurate": the only action that moves `last_verified_at`. Uses `now()`;
 * takes no date, so it can't be back-dated.
 */
export async function reverifyTool(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("tool.reverify", async () => {
    const user = await requireEditor();

    const parsed = reverifyToolSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(tools)
      .set({ lastVerifiedAt: new Date(), updatedById: user.id })
      .where(eq(tools.id, parsed.data.id))
      .returning({ id: tools.id, slug: tools.slug, status: tools.status });

    const row = updated[0];
    if (!row) return fail("notFound", "That tool does not exist.");

    // The verification date is shown publicly, so purge published entries.
    if (row.status === "published") {
      revalidateTag(TAG.tools);
      revalidateTag(TAG.tool(row.slug));
      revalidateTag(TAG.search);
    }

    return ok({ id: row.id });
  });
}

/** Bulk re-verify from `/admin/queue`, in one statement. The date is `now()`. */
export async function reverifyTools(ids: unknown): Promise<ActionResult<{ count: number }>> {
  return guard("tool.reverify.bulk", async () => {
    const user = await requireEditor();

    const parsed = toolIdSchema.array().max(200).safeParse(ids);
    if (!parsed.success) return fromZodError(parsed.error);

    const toolIds = parsed.data.map((t) => t.id);
    if (toolIds.length === 0) return ok({ count: 0 });

    const updated = await db
      .update(tools)
      .set({ lastVerifiedAt: new Date(), updatedById: user.id })
      .where(inArray(tools.id, toolIds))
      .returning({ slug: tools.slug, status: tools.status });

    revalidateTag(TAG.tools);
    revalidateTag(TAG.search);
    for (const row of updated) {
      if (row.status === "published") revalidateTag(TAG.tool(row.slug));
    }

    return ok({ count: updated.length });
  });
}
