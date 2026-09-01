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
 * Workspace mutations — the signed-in write path.
 *
 * EVERY ACTION FOLLOWS THE SAME FIVE STEPS, IN THIS ORDER:
 *
 *   1. re-check the session (`requireUser`),
 *   2. Zod-validate the payload,
 *   3. consume a rate-limit budget,
 *   4. re-check ownership IN SQL against the session user id,
 *   5. mutate.
 *
 * Step 3 is not optional and there are no exemptions. Five of these actions used to skip it
 * — including both deletes and the reorder, which opens a transaction and rewrites a whole
 * list — and the omission read as an oversight rather than a decision, because nothing said
 * why a delete should be cheaper to allow than a toggle (QA finding Q-11). It is not.
 *
 * The limiter is consumed AFTER validation but BEFORE the ownership check, except where the
 * ownership check is the same statement as the mutation. Behind validation so malformed
 * spam does not consume a legitimate user's budget; before ownership so a caller cannot
 * probe ids for free.
 *
 * Ownership is a WHERE clause wherever the mutation is a single statement, and an explicit
 * `assertOwns*` inside the transaction wherever it is not. It is never a TypeScript
 * comparison after a fetch: that loads a stranger's row into this process before deciding it
 * should not have, and it is one early `return` away from not deciding at all.
 *
 * A non-owner gets `notFound`, never `forbidden`. A 403 confirms the workspace exists, which
 * for an audience whose cases are the sensitive thing is an enumeration oracle
 * (HANDOFF §11 assertion 2).
 *
 * NO REVALIDATION ANYWHERE IN THIS FILE. caching.md §5: "Any workspace or note mutation —
 * nothing." Nothing under `/workspaces` is cached at any layer, so there is no tag to purge,
 * and `revalidateTag('tools')` here would purge the public catalogue on every checkbox click.
 *
 * A Server Action is a public HTTP endpoint with a generated name. Its arguments are
 * attacker-controlled and its authorisation is NOT inherited from the page that rendered the
 * form. That is why every one of these re-checks rather than trusting its caller.
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

    /**
     * ONE transaction. The workspace and its derived checklist must appear together: a
     * workspace created without its checklist looks like an empty case, and there is no
     * second chance to derive it because "start from this playbook" happens once.
     */
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ userId: user.id, title, playbookId })
        .returning({ id: workspaces.id });

      if (!workspace) throw new Error("Insert returned no workspace");

      if (playbookId) {
        /**
         * PUBLISHED steps only, read inside the transaction. Starting a case from a draft
         * playbook would expose unpublished editorial work through a side door.
         *
         * `title` is snapshotted from `playbook_steps.title` here and never refreshed
         * (ADR 0008): it records what the user saw when they started the case.
         */
        const steps = await tx
          .select({ id: playbookSteps.id, title: playbookSteps.title })
          .from(playbookSteps)
          .innerJoin(playbooks, eq(playbooks.id, playbookSteps.playbookId))
          .where(and(eq(playbookSteps.playbookId, playbookId), eq(playbooks.status, "published")))
          .orderBy(asc(playbookSteps.orderIndex));

        if (steps.length > 0) {
          // ONE multi-row insert, not a loop. A twelve-step playbook would otherwise be
          // twelve round trips inside a transaction holding a row lock.
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

    /**
     * Ownership is the WHERE clause, not a prior read. No returned row means either the
     * workspace does not exist or it is not the caller's, and those two answers are
     * deliberately indistinguishable.
     */
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

    // Rate limited like every other write. A delete cascades to every item and note in the
    // case, so it is among the MORE expensive statements here, not a cheap one (Q-11).
    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    // Items and notes cascade. This is a real deletion of the user's own record and is
    // correct: there is nothing of ours in their case file worth keeping (ADR 0008).
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
 * Raised inside the transaction when the snapshot's unique index already holds this feature.
 *
 * It has to unwind rather than return, because by then the `workspace_items` row is already
 * inserted and committing would leave a `mapFeature` item with no snapshot — an item that
 * renders as nothing at all. Throwing rolls the whole thing back; the catch outside turns it
 * into the ordinary "already saved" answer rather than a failure.
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
     * A LIVE FEATURE IS RESOLVED BEFORE THE TRANSACTION OPENS, AND FROM OUR OWN CACHE.
     *
     * ADR 0025 Consequences, and QA finding QV-14. The request names a source and a feature;
     * everything that is written — the coordinates, the observation instant, the source name,
     * the attribution, the licence, the title — comes from `lib/live/feature-cache.ts`, which
     * holds what the last governed poll actually returned. This is the same rule the tool
     * branch below follows by reading `tools.name` from the database, applied to a referent
     * that has no row: a snapshot assembled from a request body is a record of what the
     * client claimed, and this table exists to be citable evidence.
     *
     * It resolves OUTSIDE the transaction because it is an in-memory read that cannot fail
     * partway, and holding a row lock across it would buy nothing.
     *
     * FAIL, DO NOT FETCH. If the cache no longer holds the feature the save is refused. ADR
     * 0025 rejects re-fetching outright: adsb.lol keeps no history, so a re-fetch returns the
     * aircraft's *current* position under the original timestamp — not old, but wrong.
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
        /* The UPSTREAM's instant. Our clock records only `created_at`. */
        observedAt: resolved.observedAt,
        sourceUrl: resolved.feature.sourceUrl ?? null,
        attribution: resolved.attribution.text,
        licence: resolved.attribution.licence,
        properties: resolved.feature.properties,
        precision: resolved.feature.precision ?? null,
      });

      /*
       * A source whose adapter returns a blank credit fails the save rather than writing a
       * row without one. ODbL, CC BY and the TfL terms make the credit a condition of use, so
       * an uncreditable feature is one we may not put in an exportable case file — the same
       * fail-closed posture as `connectors_attribution_check`.
       */
      if (!candidate.success) return fromZodError(candidate.error);
      snapshot = candidate.data;
    }

    try {
      return await db.transaction(async (tx) => {
        if (!(await assertOwnsWorkspace(workspaceId, user.id, tx))) {
          return fail("notFound", NOT_FOUND);
        }

        /**
         * The snapshot title is READ FROM THE DATABASE, never taken from the client
         * (ADR 0008). It records what the entry said when the user saved it; a
         * client-supplied title would record what the client claimed.
         *
         * A tool must be published to be saved — otherwise a guessed uuid would pull an
         * unpublished draft's name into a user's case file.
         */
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
          /* Same rule, different authority: the feature's own label as the server saw it. */
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
          // A tool is saved into a workspace at most once
          // (`workspace_items_tool_unique_idx`), and one checklist entry per step. A
          // `mapFeature` item has no FK to be unique on; its uniqueness lives on the snapshot.
          .onConflictDoNothing()
          .returning({ id: workspaceItems.id });

        const row = inserted[0];
        if (!row) return fail("conflict", "That is already saved in this case.");

        /**
         * THE ITEM AND ITS SNAPSHOT ARE ONE WRITE.
         *
         * `workspace_feature_snapshots`' primary key IS its foreign key to the item
         * (ADR 0025), so exactly one snapshot per item is structural. What is not structural
         * is that the item never exists without one: a committed `mapFeature` item with no
         * snapshot has no coordinates, no source and no credit, and renders as nothing. Both
         * statements are in this transaction and `FeatureAlreadySaved` unwinds it.
         *
         * `onConflictDoNothing` covers `workspace_feature_snapshots_unique_idx` — one save
         * per feature per workspace. Re-saving reports "already saved" and writes nothing;
         * ADR 0025 rejects the alternative because a user accumulating positions for the same
         * aircraft is a flight-track table assembled one click at a time.
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

    // `workspace_items.user_id` is denormalised from the workspace precisely so this is one
    // indexed predicate rather than a join the query author has to remember (ADR 0008).
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

/**
 * Drag-to-reorder within one kind.
 *
 * ONE transaction and ONE statement. The client sends ids; the indexes are derived here from
 * array position, so a client cannot invent a position or leave a gap.
 */
export async function reorderWorkspaceItems(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return guard("workspace.item.reorder", async () => {
    const user = await requireUser();

    const parsed = reorderWorkspaceItemsSchema.safeParse(input);
    if (!parsed.success) return fromZodError(parsed.error);

    // The most expensive action in this file: a transaction, an ownership scan over the
    // submitted ids, and an `UPDATE … FROM unnest(...)` across the whole list (Q-11).
    const limit = await consumeSafely("workspace-write", user.id);
    if (!limit.ok) return fail("conflict", TOO_FAST);

    const { workspaceId, kind, itemIds } = parsed.data;

    return db.transaction(async (tx) => {
      if (!(await assertOwnsWorkspace(workspaceId, user.id, tx))) {
        return fail("notFound", NOT_FOUND);
      }

      // Every id must be the caller's, in this workspace, of this kind. A mismatch means the
      // submitted list does not describe this workspace, and applying it partially would
      // leave the ordering half-rewritten.
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

      /**
       * One statement for the whole reorder: `unnest(... ) WITH ORDINALITY` turns the id
       * array into a two-column relation of (id, position) to join against. The loop version
       * is one round trip per item inside an open transaction.
       *
       * `workspace_items` carries no uniqueness on `order_index`, so unlike playbook steps
       * this needs no deferrable constraint — but it is still one statement, because a loop
       * that fails half-way leaves a scrambled list.
       */
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

      // An anchor to somebody else's item would attach the note to a row the user cannot
      // see. Checked with the same ownership predicate, in the same transaction.
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

/**
 * Edit a note's body. `created_at` is NOT touched: it is the "timestamped" in "timestamped
 * notes", and an investigator's record of when they wrote something has to be stable
 * (db/schema.ts, `notes.createdAt`). Drizzle's `$onUpdate` moves `updated_at`.
 */
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
