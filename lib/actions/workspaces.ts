"use server";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  notes,
  playbookSteps,
  playbooks,
  tools,
  workspaceFeatureSnapshots,
  workspaceItems,
  workspaces,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { findCachedFeature } from "@/lib/live/feature-cache";
import {
  assertOwnsItem,
  assertOwnsNote,
  assertOwnsWorkspace,
  nextItemOrderIndex,
} from "@/lib/queries/workspaces";
import { consumeSafely } from "@/lib/rate-limit";
import {
  addWorkspaceItemSchema,
  createNoteSchema,
  createWorkspaceSchema,
  deleteNoteSchema,
  packSnapshotProperties,
  removeWorkspaceItemSchema,
  reorderWorkspaceItemsSchema,
  savedFeatureSchema,
  toggleWorkspaceItemSchema,
  updateNoteSchema,
  updateWorkspaceSchema,
  workspaceIdSchema,
} from "@/lib/validation/workspaces";
import { fail, fromZodError, guard, ok, type ActionResult } from "./result";

/**
 * Workspace mutations. Every action: `requireUser`, Zod-validate, consume rate limit, check
 * ownership in SQL, mutate. The limit is consumed after validation (spam doesn't burn a
 * user's budget) and before ownership (no free id probing).
 *
 * Ownership is a WHERE clause for single statements, or `assertOwns*` inside the transaction.
 * Non-owners get `notFound`, never `forbidden`, so existence isn't revealed.
 *
 * No revalidation: nothing under `/workspaces` is cached.
 */

const NOT_FOUND = "That case file does not exist.";
const TOO_FAST = "Too many changes at once. Try again in a minute.";

export async function createWorkspace(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("workspace.create", async () => {
    const user = await requireUser();

    const parsed = createWorkspaceSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { title, playbookId } = parsed.data;

    // Workspace and derived checklist are created together.
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ userId: user.id, title, playbookId })
        .returning({ id: workspaces.id });

      if (!workspace) throw new Error("Insert returned no workspace");

      if (playbookId) {
        // Published steps only. Titles are snapshotted and never refreshed.
        const steps = await tx
          .select({ id: playbookSteps.id, title: playbookSteps.title })
          .from(playbookSteps)
          .innerJoin(playbooks, eq(playbooks.id, playbookSteps.playbookId))
          .where(and(eq(playbookSteps.playbookId, playbookId), eq(playbooks.status, "published")))
          .orderBy(asc(playbookSteps.orderIndex));

        if (steps.length > 0) {
          await tx.insert(workspaceItems).values(
            steps.map((step, index) => ({
              workspaceId: workspace.id,
              userId: user.id,
              kind: "checklistStep" as const,
              stepId: step.id,
              title: step.title,
              orderIndex: index,
            })),
          );
        }
      }

      return workspace.id;
    });

    return ok({ id: result });
  });
}

export async function updateWorkspace(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("workspace.update", async () => {
    const user = await requireUser();

    const parsed = updateWorkspaceSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { id, title, status } = parsed.data;

    // Ownership in the WHERE clause; "missing" and "not yours" look the same.
    const updated = await db
      .update(workspaces)
      .set({ title, status })
      .where(and(eq(workspaces.id, id), eq(workspaces.userId, user.id)))
      .returning({ id: workspaces.id });

    const row = updated[0];
    if (!row) return fail("notFound", NOT_FOUND);
    return ok({ id: row.id });
  });
}

export async function deleteWorkspace(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("workspace.delete", async () => {
    const user = await requireUser();

    const parsed = workspaceIdSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    // Items and notes cascade.
    const deleted = await db
      .delete(workspaces)
      .where(and(eq(workspaces.id, parsed.data.id), eq(workspaces.userId, user.id)))
      .returning({ id: workspaces.id });

    const row = deleted[0];
    if (!row) return fail("notFound", NOT_FOUND);
    return ok({ id: row.id });
  });
}

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

/**
 * Thrown when the snapshot already exists, to roll back the just-inserted item (an item
 * without a snapshot renders as nothing). Caught and reported as "already saved".
 */
class FeatureAlreadySaved extends Error {
  constructor() {
    super("feature already saved in this workspace");
    this.name = "FeatureAlreadySaved";
  }
}

export async function addWorkspaceItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("workspace.item.add", async () => {
    const user = await requireUser();

    const parsed = addWorkspaceItemSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { workspaceId, kind, toolId, stepId, feature } = parsed.data;

    /**
     * Live features are resolved from `lib/live/feature-cache.ts` (outside the transaction;
     * it's an in-memory read). Everything written comes from the cache, not the request.
     * If the feature is gone the save fails: re-fetching would pair a current position with
     * the original timestamp.
     */
    let snapshot: ReturnType<typeof savedFeatureSchema.parse> | null = null;
    if (kind === "mapFeature" && feature) {
      const resolved = findCachedFeature(feature.sourceSlug, feature.featureRef);
      if (!resolved) {
        return fail(
          "notFound",
          "That feature is no longer available to save. Live sources keep no history, so it cannot be recovered.",
        );
      }

      const candidate = savedFeatureSchema.safeParse({
        sourceSlug: resolved.sourceSlug,
        sourceName: resolved.sourceName,
        sourceKind: resolved.sourceKind,
        featureRef: resolved.feature.id,
        label: resolved.feature.label,
        latitude: resolved.feature.latitude,
        longitude: resolved.feature.longitude,
        altitudeMetres: resolved.feature.altitude ?? null,
        /* The upstream's instant; our clock is only `created_at`. */
        observedAt: resolved.observedAt,
        sourceUrl: resolved.feature.sourceUrl ?? null,
        attribution: resolved.attribution.text,
        licence: resolved.attribution.licence,
        properties: resolved.feature.properties,
        precision: resolved.feature.precision ?? null,
      });

      // A blank credit fails the save; licences like ODbL / CC BY require it.
      if (!candidate.success) return fromZodError(candidate.error);
      snapshot = candidate.data;
    }

    try {
      return await db.transaction(async (tx) => {
        if (!(await assertOwnsWorkspace(workspaceId, user.id, tx))) {
          return fail("notFound", NOT_FOUND);
        }

        // Title is read server-side, never from the client. Only published entries can be
        // saved, so a guessed uuid can't leak a draft's name.
        let title: string | undefined;
        if (kind === "tool" && toolId) {
          const row = await tx
            .select({ name: tools.name })
            .from(tools)
            .where(and(eq(tools.id, toolId), eq(tools.status, "published")))
            .limit(1);
          title = row[0]?.name;
        } else if (kind === "checklistStep" && stepId) {
          const row = await tx
            .select({ title: playbookSteps.title })
            .from(playbookSteps)
            .innerJoin(playbooks, eq(playbooks.id, playbookSteps.playbookId))
            .where(and(eq(playbookSteps.id, stepId), eq(playbooks.status, "published")))
            .limit(1);
          title = row[0]?.title;
        } else if (kind === "mapFeature" && snapshot) {
          /* The feature's label as the server saw it. */
          title = snapshot.label;
        }

        if (!title) return fail("notFound", "That entry is no longer available to save.");

        const orderIndex = await nextItemOrderIndex(workspaceId, kind, tx);

        const inserted = await tx
          .insert(workspaceItems)
          .values({
            workspaceId,
            userId: user.id,
            kind,
            toolId: kind === "tool" ? toolId : null,
            stepId: kind === "checklistStep" ? stepId : null,
            title,
            orderIndex,
          })
          // One per tool / step per workspace; `mapFeature` uniqueness is on the snapshot.
          .onConflictDoNothing()
          .returning({ id: workspaceItems.id });

        const row = inserted[0];
        if (!row) return fail("conflict", "That is already saved in this case.");

        /**
         * Item and snapshot are written together; `FeatureAlreadySaved` rolls back the item.
         * One save per feature per workspace, so repeated saves can't build a flight track.
         */
        if (kind === "mapFeature" && snapshot) {
          const snapshotRow = await tx
            .insert(workspaceFeatureSnapshots)
            .values({
              workspaceItemId: row.id,
              workspaceId,
              userId: user.id,
              sourceSlug: snapshot.sourceSlug,
              sourceName: snapshot.sourceName,
              sourceKind: snapshot.sourceKind,
              featureRef: snapshot.featureRef,
              latitude: snapshot.latitude,
              longitude: snapshot.longitude,
              altitudeMetres: snapshot.altitudeMetres,
              observedAt: snapshot.observedAt,
              sourceUrl: snapshot.sourceUrl,
              attribution: snapshot.attribution,
              licence: snapshot.licence,
              properties: packSnapshotProperties(snapshot.properties, snapshot.precision),
            })
            .onConflictDoNothing()
            .returning({ id: workspaceFeatureSnapshots.workspaceItemId });

          if (!snapshotRow[0]) throw new FeatureAlreadySaved();
        }

        return ok({ id: row.id });
      });
    } catch (error) {
      if (error instanceof FeatureAlreadySaved) {
        return fail("conflict", "That is already saved in this case.");
      }
      throw error;
    }
  });
}

export async function toggleWorkspaceItem(
  input: unknown,
): Promise<ActionResult<{ id: string; checked: boolean }>> {
  return guard("workspace.item.toggle", async () => {
    const user = await requireUser();

    const parsed = toggleWorkspaceItemSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { id, checked } = parsed.data;

    // `user_id` is denormalised onto items so ownership is one predicate, no join.
    const updated = await db
      .update(workspaceItems)
      .set({ checked, checkedAt: checked ? new Date() : null })
      .where(and(eq(workspaceItems.id, id), eq(workspaceItems.userId, user.id)))
      .returning({ id: workspaceItems.id, checked: workspaceItems.checked });

    const row = updated[0];
    if (!row) return fail("notFound", "That entry does not exist.");
    return ok(row);
  });
}

export async function removeWorkspaceItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("workspace.item.remove", async () => {
    const user = await requireUser();

    const parsed = removeWorkspaceItemSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const deleted = await db
      .delete(workspaceItems)
      .where(and(eq(workspaceItems.id, parsed.data.id), eq(workspaceItems.userId, user.id)))
      .returning({ id: workspaceItems.id });

    const row = deleted[0];
    if (!row) return fail("notFound", "That entry does not exist.");
    return ok({ id: row.id });
  });
}

/** Drag-to-reorder within one kind. Indexes come from array position. */
export async function reorderWorkspaceItems(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return guard("workspace.item.reorder", async () => {
    const user = await requireUser();

    const parsed = reorderWorkspaceItemsSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { workspaceId, kind, itemIds } = parsed.data;

    return db.transaction(async (tx) => {
      if (!(await assertOwnsWorkspace(workspaceId, user.id, tx))) {
        return fail("notFound", NOT_FOUND);
      }

      // Every id must be the caller's, in this workspace, of this kind.
      const owned = await tx
        .select({ id: workspaceItems.id })
        .from(workspaceItems)
        .where(
          and(
            eq(workspaceItems.workspaceId, workspaceId),
            eq(workspaceItems.userId, user.id),
            eq(workspaceItems.kind, kind),
            inArray(workspaceItems.id, itemIds),
          ),
        );

      if (owned.length !== itemIds.length) {
        return fail("notFound", "That list has changed. Reload and try again.");
      }

      // One statement via `unnest(...) WITH ORDINALITY`.
      await tx.execute(sql`
        update ${workspaceItems} i
        set order_index = v.pos - 1
        from (select id, ordinality as pos
              from unnest(${sql.param(itemIds)}::uuid[]) with ordinality as t(id, ordinality)) v
        where i.id = v.id and i.user_id = ${user.id} and i.workspace_id = ${workspaceId}
      `);

      return ok({ count: itemIds.length });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export async function createNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("note.create", async () => {
    const user = await requireUser();

    const parsed = createNoteSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("note-write", user.id);
    if (!limit.ok) return fail("conflict", "Too many notes at once. Try again in a minute.");

    const { workspaceId, body, workspaceItemId, playbookStepId } = parsed.data;

    return db.transaction(async (tx) => {
      if (!(await assertOwnsWorkspace(workspaceId, user.id, tx))) {
        return fail("notFound", NOT_FOUND);
      }

      // The anchor item must also be the caller's.
      if (workspaceItemId && !(await assertOwnsItem(workspaceItemId, user.id, tx))) {
        return fail("notFound", "That entry does not exist.");
      }

      const inserted = await tx
        .insert(notes)
        .values({ workspaceId, userId: user.id, body, workspaceItemId, playbookStepId })
        .returning({ id: notes.id });

      const row = inserted[0];
      if (!row) throw new Error("Insert returned no note");
      return ok({ id: row.id });
    });
  });
}

/** Edit a note's body. `created_at` is never touched; `$onUpdate` moves `updated_at`. */
export async function updateNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("note.update", async () => {
    const user = await requireUser();

    const parsed = updateNoteSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("note-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const updated = await db
      .update(notes)
      .set({ body: parsed.data.body })
      .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, user.id)))
      .returning({ id: notes.id });

    const row = updated[0];
    if (!row) return fail("notFound", "That note does not exist.");
    return ok({ id: row.id });
  });
}

export async function deleteNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard("note.delete", async () => {
    const user = await requireUser();

    const parsed = deleteNoteSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    const limit = await consumeSafely("note-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    if (!(await assertOwnsNote(parsed.data.id, user.id))) {
      return fail("notFound", "That note does not exist.");
    }

    const deleted = await db
      .delete(notes)
      .where(and(eq(notes.id, parsed.data.id), eq(notes.userId, user.id)))
      .returning({ id: notes.id });

    const row = deleted[0];
    if (!row) return fail("notFound", "That note does not exist.");
    return ok({ id: row.id });
  });
}
