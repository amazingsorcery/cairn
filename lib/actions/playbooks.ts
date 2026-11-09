"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, inArray, sql } from "drizzle-orm";

import { categories, playbookStepTools, playbookSteps, playbooks } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { db } from "@/lib/db";
import { TAG } from "@/lib/queries/cache";
import {
  createPlaybookSchema,
  playbookIdSchema,
  publishPlaybookSchema,
  reorderPlaybookStepsSchema,
  replacePlaybookStepsSchema,
  reverifyPlaybookSchema,
  updatePlaybookSchema,
} from "@/lib/validation/playbooks";
import { fail, fromZodError, guard, ok, type ActionResult } from "./result";
import { recomputePlaybookSearchKeywords } from "./search-keywords";

/**
 * Editorial mutations on `playbooks` and `playbook_steps`. Same rules as `tools.ts`:
 * recompute `search_keywords` in-transaction, revalidate after commit, no purge for drafts.
 */

async function categorySlugFor(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  categoryId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ slug: categories.slug })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1);
  return row?.slug ?? null;
}

export async function createPlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.create", async () => {
    const user = await requireEditor();

    const parsed = createPlaybookSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(playbooks)
        .values({ ...parsed.data, updatedById: user.id })
        .returning({ id: playbooks.id });

      if (!row) throw new Error("Insert returned no playbook");
      await recomputePlaybookSearchKeywords(tx, [row.id]);
      return row.id;
    });

    // New playbooks are drafts; nothing to purge.
    return ok({ id });
  });
}

export async function updatePlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.update", async () => {
    const user = await requireEditor();

    const parsed = updatePlaybookSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { id, ...fields } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(playbooks)
        // No `lastVerifiedAt`: a save never moves it.
        .set({ ...fields, updatedById: user.id })
        .where(eq(playbooks.id, id))
        .returning({ id: playbooks.id, slug: playbooks.slug, status: playbooks.status });

      if (!row) return null;

      // The category name is part of `search_keywords`, so a category change fans out here.
      await recomputePlaybookSearchKeywords(tx, [id]);
      return { ...row, categorySlug: await categorySlugFor(tx, fields.categoryId) };
    });

    if (!result) return fail("notFound", "That playbook does not exist.");

    if (result.status === "published") {
      revalidateTag(TAG.playbooks);
      revalidateTag(TAG.playbook(result.slug));
      if (result.categorySlug) revalidateTag(TAG.category(result.categorySlug));
      revalidateTag(TAG.search);
    }

    return ok({ id: result.id });
  });
}

/**
 * Replace the whole step list in one transaction (contiguity is a property of the set).
 * Step ids change, so existing checklist items keep their title and checked state but lose
 * the link (`ON DELETE SET NULL`).
 */
export async function replacePlaybookSteps(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return guard("playbook.steps.replace", async () => {
    const user = await requireEditor();

    const parsed = replacePlaybookStepsSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { playbookId, steps } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [playbook] = await tx
        .select({ id: playbooks.id, slug: playbooks.slug, status: playbooks.status })
        .from(playbooks)
        .where(eq(playbooks.id, playbookId))
        .limit(1);

      if (!playbook) return null;

      await tx.delete(playbookSteps).where(eq(playbookSteps.playbookId, playbookId));

      // The order unique constraint is deferred, so it's checked at commit.
      const inserted = await tx
        .insert(playbookSteps)
        .values(
          steps.map((step) => ({
            playbookId,
            orderIndex: step.orderIndex,
            title: step.title,
            objective: step.objective,
            body: step.body,
            doneWhen: step.doneWhen,
          })),
        )
        .returning({ id: playbookSteps.id, orderIndex: playbookSteps.orderIndex });

      const idByOrder = new Map(inserted.map((row) => [row.orderIndex, row.id]));

      const links = steps.flatMap((step) => {
        const stepId = idByOrder.get(step.orderIndex);
        if (!stepId) return [];
        return step.toolLinks.map((link) => ({
          stepId,
          toolId: link.toolId,
          note: link.note,
          orderIndex: link.orderIndex,
        }));
      });

      if (links.length > 0) {
        await tx.insert(playbookStepTools).values(links).onConflictDoNothing();
      }

      // Step titles and objectives feed `search_keywords`.
      await recomputePlaybookSearchKeywords(tx, [playbookId]);
      await tx.update(playbooks).set({ updatedById: user.id }).where(eq(playbooks.id, playbookId));

      return { slug: playbook.slug, status: playbook.status, count: inserted.length };
    });

    if (!result) return fail("notFound", "That playbook does not exist.");

    if (result.status === "published") {
      revalidateTag(TAG.playbooks);
      revalidateTag(TAG.playbook(result.slug));
      revalidateTag(TAG.search);
    }

    return ok({ count: result.count });
  });
}

/**
 * Drag-to-reorder in one statement; relies on the deferred unique constraint since swaps
 * transiently duplicate `order_index`. Indexes come from array position.
 */
export async function reorderPlaybookSteps(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return guard("playbook.steps.reorder", async () => {
    const user = await requireEditor();

    const parsed = reorderPlaybookStepsSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const { playbookId, stepIds } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const [playbook] = await tx
        .select({ slug: playbooks.slug, status: playbooks.status })
        .from(playbooks)
        .where(eq(playbooks.id, playbookId))
        .limit(1);

      if (!playbook) return null;

      // Must be exactly this playbook's full step list, or gaps would appear.
      const existing = await tx
        .select({ id: playbookSteps.id })
        .from(playbookSteps)
        .where(eq(playbookSteps.playbookId, playbookId));

      if (existing.length !== stepIds.length) {
        return { mismatch: true as const };
      }
      const known = new Set(existing.map((s) => s.id));
      if (stepIds.some((id) => !known.has(id))) {
        return { mismatch: true as const };
      }

      await tx.execute(sql`
        update ${playbookSteps} s
        set order_index = v.pos - 1
        from (select id, ordinality as pos
              from unnest(${sql.param(stepIds)}::uuid[]) with ordinality as t(id, ordinality)) v
        where s.id = v.id and s.playbook_id = ${playbookId}
      `);

      // Step order affects `search_keywords`.
      await recomputePlaybookSearchKeywords(tx, [playbookId]);
      await tx.update(playbooks).set({ updatedById: user.id }).where(eq(playbooks.id, playbookId));

      return { slug: playbook.slug, status: playbook.status, count: stepIds.length };
    });

    if (!result) return fail("notFound", "That playbook does not exist.");
    if ("mismatch" in result) {
      return fail("conflict", "The step list has changed. Reload and try again.");
    }

    if (result.status === "published") {
      revalidateTag(TAG.playbooks);
      revalidateTag(TAG.playbook(result.slug));
      revalidateTag(TAG.search);
    }

    return ok({ count: result.count });
  });
}

export async function publishPlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.publish", async () => {
    const user = await requireEditor();

    const parsed = playbookIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: playbooks.id,
          slug: playbooks.slug,
          categoryId: playbooks.categoryId,
          lastVerifiedAt: playbooks.lastVerifiedAt,
          publishedAt: playbooks.publishedAt,
        })
        .from(playbooks)
        .where(eq(playbooks.id, parsed.data.id))
        .limit(1);

      if (!current) return { kind: "notFound" as const };

      const gate = publishPlaybookSchema.safeParse({
        id: current.id,
        lastVerifiedAt: current.lastVerifiedAt,
      });
      if (!gate.success) return { kind: "gate" as const, error: gate.error };

      // Needs a cross-table check, so it's enforced here rather than in the DB.
      const [stepCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(playbookSteps)
        .where(eq(playbookSteps.playbookId, current.id));

      if ((stepCount?.count ?? 0) < 2) {
        return { kind: "noSteps" as const };
      }

      await tx
        .update(playbooks)
        .set({
          status: "published",
          publishedAt: current.publishedAt ?? new Date(),
          updatedById: user.id,
        })
        .where(eq(playbooks.id, current.id));

      return {
        kind: "ok" as const,
        id: current.id,
        slug: current.slug,
        categorySlug: await categorySlugFor(tx, current.categoryId),
      };
    });

    if (result.kind === "notFound") return fail("notFound", "That playbook does not exist.");
    if (result.kind === "gate") return fromZodError(result.error);
    if (result.kind === "noSteps") {
      return fail("validation", "A playbook needs at least two steps before it can be published.");
    }

    revalidateTag(TAG.playbooks);
    revalidateTag(TAG.playbook(result.slug));
    if (result.categorySlug) revalidateTag(TAG.category(result.categorySlug));
    revalidateTag(TAG.search);
    revalidatePath("/playbooks");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

export async function unpublishPlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.unpublish", async () => {
    const user = await requireEditor();

    const parsed = playbookIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(playbooks)
        // `published_at` is not cleared.
        .set({ status: "draft", updatedById: user.id })
        .where(eq(playbooks.id, parsed.data.id))
        .returning({
          id: playbooks.id,
          slug: playbooks.slug,
          categoryId: playbooks.categoryId,
        });

      if (!row) return null;
      return { ...row, categorySlug: await categorySlugFor(tx, row.categoryId) };
    });

    if (!result) return fail("notFound", "That playbook does not exist.");

    revalidateTag(TAG.playbooks);
    revalidateTag(TAG.playbook(result.slug));
    if (result.categorySlug) revalidateTag(TAG.category(result.categorySlug));
    revalidateTag(TAG.search);
    revalidatePath("/playbooks");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

export async function deletePlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.delete", async () => {
    await requireEditor();

    const parsed = playbookIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: playbooks.id, slug: playbooks.slug, categoryId: playbooks.categoryId })
        .from(playbooks)
        .where(eq(playbooks.id, parsed.data.id))
        .limit(1);

      if (!current) return null;

      const categorySlug = await categorySlugFor(tx, current.categoryId);
      // Steps cascade; `workspaces.playbook_id` and `workspace_items.step_id` are
      // ON DELETE SET NULL, so open cases keep their checklists.
      await tx.delete(playbooks).where(eq(playbooks.id, current.id));
      return { id: current.id, slug: current.slug, categorySlug };
    });

    if (!result) return fail("notFound", "That playbook does not exist.");

    revalidateTag(TAG.playbooks);
    revalidateTag(TAG.playbook(result.slug));
    if (result.categorySlug) revalidateTag(TAG.category(result.categorySlug));
    revalidateTag(TAG.search);
    revalidatePath("/playbooks");
    revalidatePath("/");

    return ok({ id: result.id });
  });
}

/** "Confirm still accurate". The date is `now()`, never supplied by the caller. */
export async function reverifyPlaybook(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("playbook.reverify", async () => {
    const user = await requireEditor();

    const parsed = reverifyPlaybookSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const updated = await db
      .update(playbooks)
      .set({ lastVerifiedAt: new Date(), updatedById: user.id })
      .where(eq(playbooks.id, parsed.data.id))
      .returning({ id: playbooks.id, slug: playbooks.slug, status: playbooks.status });

    const row = updated[0];
    if (!row) return fail("notFound", "That playbook does not exist.");

    if (row.status === "published") {
      revalidateTag(TAG.playbooks);
      revalidateTag(TAG.playbook(row.slug));
      revalidateTag(TAG.search);
    }

    return ok({ id: row.id });
  });
}

/** Bulk re-verify from `/admin/queue`, in one statement. */
export async function reverifyPlaybooks(ids: unknown): Promise<ActionResult<{ count: number }>> {
  return guard("playbook.reverify.bulk", async () => {
    const user = await requireEditor();

    const parsed = playbookIdSchema.array().max(200).safeParse(ids);
    if (!parsed.success) return fromZodError(parsed.error);

    const playbookIds = parsed.data.map((p) => p.id);
    if (playbookIds.length === 0) return ok({ count: 0 });

    const updated = await db
      .update(playbooks)
      .set({ lastVerifiedAt: new Date(), updatedById: user.id })
      .where(inArray(playbooks.id, playbookIds))
      .returning({ slug: playbooks.slug, status: playbooks.status });

    revalidateTag(TAG.playbooks);
    revalidateTag(TAG.search);
    for (const row of updated) {
      if (row.status === "published") revalidateTag(TAG.playbook(row.slug));
    }

    return ok({ count: updated.length });
  });
}
