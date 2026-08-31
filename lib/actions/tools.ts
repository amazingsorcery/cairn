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
 * Editorial mutations on `tools`. `editor` or `admin` (sitemap.md §8).
 *
 * THREE things every action here gets right, and each of them is a silent failure if not:
 *
 * 1. **`search_keywords` is recomputed IN THE SAME TRANSACTION** as any write that changes
 *    the category, the tags, or the facet arrays (HANDOFF §4). The `search_vector` generated
 *    column reads that text column, so a missed recompute means the entry is in the
 *    catalogue and unfindable by the facet that should find it. Nothing errors.
 * 2. **Revalidation runs AFTER commit, never inside the transaction** (caching.md §5). A
 *    rolled-back transaction that already purged the cache serves a re-render of stale data
 *    with a fresh timestamp — worse than the stale entry it replaced.
 * 3. **Draft edits purge nothing** (caching.md §5.1). A draft is on no public page, and
 *    purging on every keystroke-save would make the cache useless during an editing session.
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

      // Same transaction as the insert. HANDOFF §4.
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
        // `last_verified_at` is deliberately absent: a save NEVER moves it (ADR 0007 §8).
        // Coupling them would let a typo fix silently assert that every claim on the page
        // was re-checked. `reverifyTool` is the only path that touches it.
        .set({ ...fields, updatedById: user.id })
        .where(eq(tools.id, id))
        .returning({ id: tools.id, slug: tools.slug, status: tools.status });

      if (!row) return null;

      // Replace the tag set wholesale. A diff would be three statements to save one.
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

    // Only a PUBLISHED tool has cache entries to purge (caching.md §5.1).
    if (result.status === "published" && result.categorySlug) {
      for (const tag of toolTags_(result.slug, result.categorySlug, result.tagSlugs)) {
        revalidateTag(tag);
      }
    }

    return ok({ id: result.id });
  });
}

/**
 * Publish. The database is the enforcement (`tools_published_requires_verification_check`);
 * the Zod check above it exists so the editor is told which field is missing rather than
 * being shown a constraint name.
 *
 * `published_at` is set on the FIRST transition to published and never cleared on unpublish
 * (HANDOFF §4) — it drives the "recently added" ordering, and clearing it would make an
 * unpublish-republish cycle look like a brand-new entry.
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
    // Belt and braces on the two highest-traffic listing paths (caching.md §1).
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
        // `published_at` is NOT cleared. HANDOFF §4.
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
 * Delete.
 *
 * THE TRAP: `/playbooks/[slug]` renders the name and summary of every linked tool, so its
 * cache entry contains data from `tools`. Deleting the tool cascades away
 * `playbook_step_tools`, after which there is nothing left to join and the affected playbook
 * slugs are unrecoverable. They are therefore collected BEFORE the delete, inside the same
 * transaction (caching.md §5.2, HANDOFF §7).
 *
 * `workspace_items` rows survive with their `title` and `checked` state intact and
 * `tool_id` null — that is `ON DELETE SET NULL` and ADR 0008, and it is the whole point.
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
 * "Confirm still accurate" — the ONLY action that moves `last_verified_at` (ADR 0007 §8).
 *
 * It takes no date from the caller. The date is `now()`, because the claim being recorded is
 * that a human looked *now*; accepting a date would make back-dating a form field, which is
 * the dishonesty product-brief §6.3 forbids.
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

    // The verification date renders on every public surface where the entry appears
    // (ADR 0007 §3), so a published entry's caches must be purged.
    if (row.status === "published") {
      revalidateTag(TAG.tools);
      revalidateTag(TAG.tool(row.slug));
      revalidateTag(TAG.search);
    }

    return ok({ id: row.id });
  });
}

/**
 * Bulk re-verify from `/admin/queue`. Same rule: the date is `now()`, never supplied.
 * ONE statement for the whole set — the queue's whole purpose is clearing a backlog, and a
 * per-row round trip would make that unusable at any real size.
 */
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
