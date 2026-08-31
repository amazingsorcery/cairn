import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  notes,
  playbooks,
  workspaceItems,
  workspaces,
  type ConfidenceLevel,
  type WorkspaceItemKind,
  type WorkspaceStatus,
} from "@/db/schema";
import { db, type Db } from "@/lib/db";

/**
 * The signed-in read layer.
 *
 * NOTHING IN THIS FILE IS CACHED, and that is not an oversight. `caching.md` §6: "Never
 * cache a query whose result depends on the session. If a query takes a `userId`, it does
 * not belong in `unstable_cache`." A workspace row leaking into a shared cache is the worst
 * bug this product can ship, so every function here takes a `userId` and none of them is
 * wrapped. The absence of an import from `./cache` is the enforcement.
 *
 * OWNERSHIP IS A SQL PREDICATE, never a TypeScript comparison (HANDOFF §7, sitemap.md §7).
 * Every query is `where id = $1 and user_id = $2`. Fetch-then-compare is wrong twice over:
 * it loads a stranger's row into this process before deciding it should not have, and it is
 * one early `return` away from not deciding at all.
 *
 * A NON-OWNER GETS null, WHICH THE ROUTE TURNS INTO 404 — never 403. A 403 confirms the
 * workspace exists, which for an audience whose cases are the sensitive thing is an
 * enumeration oracle (HANDOFF §11 assertion 2).
 *
 * `workspace_items.user_id` and `notes.user_id` are denormalised from `workspaces.user_id`
 * precisely so that predicate needs no join (ADR 0008). A workspace never changes owner —
 * there is no transfer feature and no route that would allow one — so the denormalisation
 * cannot drift.
 */

export type WorkspaceSummary = {
  id: string;
  title: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
  playbookSlug: string | null;
  playbookTitle: string | null;
  itemCount: number;
  checkedCount: number;
  noteCount: number;
};

/**
 * `/workspaces` — the user's own list.
 *
 * ONE round trip. The three counts are correlated subqueries rather than three joins: two
 * one-to-many joins onto the same parent multiply against each other, and undoing that with
 * `count(DISTINCT …)` is both slower and easier to get wrong than writing what is meant.
 *
 * `user_id` is bound. It comes from the session, never from the request payload.
 */
export async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    status: WorkspaceStatus;
    created_at: Date;
    updated_at: Date;
    playbook_slug: string | null;
    playbook_title: string | null;
    item_count: string;
    checked_count: string;
    note_count: string;
  }>(sql`
    select w.id,
           w.title,
           w.status,
           w.created_at,
           w.updated_at,
           p.slug  as playbook_slug,
           p.title as playbook_title,
           (select count(*) from ${workspaceItems} i where i.workspace_id = w.id) as item_count,
           (select count(*) from ${workspaceItems} i
             where i.workspace_id = w.id and i.checked) as checked_count,
           (select count(*) from ${notes} n where n.workspace_id = w.id) as note_count
    from ${workspaces} w
    left join ${playbooks} p on p.id = w.playbook_id
    where w.user_id = ${userId}
    order by w.updated_at desc
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    playbookSlug: row.playbook_slug,
    playbookTitle: row.playbook_title,
    itemCount: Number(row.item_count),
    checkedCount: Number(row.checked_count),
    noteCount: Number(row.note_count),
  }));
}

export type WorkspaceItemView = {
  id: string;
  kind: WorkspaceItemKind;
  /** Snapshot taken when the item was saved. Never refreshed (ADR 0008). */
  title: string;
  orderIndex: number;
  checked: boolean;
  checkedAt: Date | null;
  createdAt: Date;
  /**
   * Null when the referenced row was deleted, or when the tool was unpublished. The UI
   * renders the line as plain text without a link. ADR 0008: this is the expected state for
   * a long-running case, not an edge case.
   */
  toolSlug: string | null;
  /**
   * The tool's CURRENT confidence and verification date — not a snapshot.
   *
   * Both are null whenever `toolSlug` is null, i.e. when the tool was deleted or unpublished.
   * `title` is the snapshot and never changes (ADR 0008); these two deliberately do, because
   * architecture HANDOFF §9.1 requires the live confidence and last-verified date wherever an
   * entry appears, and a stale chip would assert a freshness we cannot support.
   *
   * They are joined here rather than fetched per row. QA finding Q-15: the previous approach
   * called `getToolBySlug` once per saved tool, which after the read split is TWO round trips
   * each — sixty statements for a thirty-tool case on a cold cache.
   */
  toolConfidence: ConfidenceLevel | null;
  toolLastVerifiedAt: Date | null;
  toolId: string | null;
  stepId: string | null;
  playbookSlug: string | null;
  stepOrderIndex: number | null;
};

export type NoteView = {
  id: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  workspaceItemId: string | null;
  playbookStepId: string | null;
};

export type WorkspaceDetail = {
  id: string;
  title: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
  playbook: { slug: string; title: string } | null;
  checklist: WorkspaceItemView[];
  savedTools: WorkspaceItemView[];
  notes: NoteView[];
};

/**
 * `/workspaces/[id]` — the whole case in one page (sitemap.md §7: three regions, not three
 * routes).
 *
 * THREE round trips, run concurrently after the ownership check:
 *   1. the workspace row, with ownership in the predicate,
 *   2. its items, with the tool slug and the step's playbook slug joined in,
 *   3. its notes.
 *
 * Items and notes could be folded into (1) as json aggregates, at the cost of a query no
 * one can read. Three statements on an uncached page whose whole point is having the case
 * in front of you is the right trade; the thing that matters is that none of them is *per
 * row*.
 *
 * Queries 2 and 3 carry `user_id = $2` as well, even though the workspace has already been
 * proven to belong to the caller. It costs an indexed equality and it means a future
 * refactor that drops the first check cannot turn these into an information leak.
 */
export async function getWorkspace(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceDetail | null> {
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)),
    with: { playbook: { columns: { slug: true, title: true } } },
  });

  // Not found and not yours are the same answer. Deliberately.
  if (!workspace) return null;

  const [items, noteRows] = await Promise.all([
    db.execute<{
      id: string;
      kind: WorkspaceItemKind;
      title: string;
      order_index: number;
      checked: boolean;
      checked_at: Date | null;
      created_at: Date;
      tool_id: string | null;
      tool_slug: string | null;
      tool_confidence: ConfidenceLevel | null;
      tool_last_verified_at: Date | null;
      step_id: string | null;
      step_order_index: number | null;
      playbook_slug: string | null;
    }>(sql`
      select i.id,
             i.kind,
             i.title,
             i.order_index,
             i.checked,
             i.checked_at,
             i.created_at,
             i.tool_id,
             -- Null for an unpublished or deleted tool: the snapshot title still renders,
             -- but as plain text rather than a link to a page that 404s.
             case when t.status = 'published' then t.slug end as tool_slug,
             case when t.status = 'published' then t.confidence end as tool_confidence,
             case when t.status = 'published' then t.last_verified_at end as tool_last_verified_at,
             i.step_id,
             s.order_index as step_order_index,
             case when pb.status = 'published' then pb.slug end as playbook_slug
      from ${workspaceItems} i
      left join tools t on t.id = i.tool_id
      left join playbook_steps s on s.id = i.step_id
      left join playbooks pb on pb.id = s.playbook_id
      where i.workspace_id = ${workspaceId} and i.user_id = ${userId}
      order by i.kind, i.order_index, i.created_at
    `),
    db
      .select({
        id: notes.id,
        body: notes.body,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        workspaceItemId: notes.workspaceItemId,
        playbookStepId: notes.playbookStepId,
      })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), eq(notes.userId, userId)))
      .orderBy(desc(notes.createdAt)),
  ]);

  const views: WorkspaceItemView[] = items.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    orderIndex: row.order_index,
    checked: row.checked,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    toolId: row.tool_id,
    toolSlug: row.tool_slug,
    toolConfidence: row.tool_confidence,
    toolLastVerifiedAt: row.tool_last_verified_at,
    stepId: row.step_id,
    stepOrderIndex: row.step_order_index,
    playbookSlug: row.playbook_slug,
  }));

  return {
    id: workspace.id,
    title: workspace.title,
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    playbook: workspace.playbook ?? null,
    checklist: views
      .filter((v) => v.kind === "checklistStep")
      .sort((a, b) => a.orderIndex - b.orderIndex),
    savedTools: views.filter((v) => v.kind === "tool").sort((a, b) => a.orderIndex - b.orderIndex),
    notes: noteRows,
  };
}

/**
 * Ownership as a boolean, for actions that need to authorise before they write.
 *
 * Returns the id, not the row: an action needs to know that the caller owns it, not what is
 * in it, and returning less means less can be leaked by a careless caller. Accepts a
 * transaction so the check and the write are one atomic unit — checking outside the
 * transaction leaves a window in which ownership could change (it cannot today, but the
 * pattern should not depend on that).
 */
export async function assertOwnsWorkspace(
  workspaceId: string,
  userId: string,
  client: Db = db,
): Promise<string | null> {
  const row = await client
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)))
    .limit(1);
  return row[0]?.id ?? null;
}

/**
 * Ownership of an ITEM, resolved to its workspace in one statement.
 *
 * The naive version reads the item, then reads its workspace, then compares owners — three
 * steps and two chances to forget one. `workspace_items.user_id` exists so this is a single
 * indexed predicate (ADR 0008).
 */
export async function assertOwnsItem(
  itemId: string,
  userId: string,
  client: Db = db,
): Promise<{ id: string; workspaceId: string; kind: WorkspaceItemKind } | null> {
  const row = await client
    .select({
      id: workspaceItems.id,
      workspaceId: workspaceItems.workspaceId,
      kind: workspaceItems.kind,
    })
    .from(workspaceItems)
    .where(and(eq(workspaceItems.id, itemId), eq(workspaceItems.userId, userId)))
    .limit(1);
  return row[0] ?? null;
}

export async function assertOwnsNote(
  noteId: string,
  userId: string,
  client: Db = db,
): Promise<{ id: string; workspaceId: string } | null> {
  const row = await client
    .select({ id: notes.id, workspaceId: notes.workspaceId })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  return row[0] ?? null;
}

/**
 * Everything `/workspaces/[id]/export` needs, in the shape the Markdown and PDF renderers
 * consume. It is `getWorkspace` — the export must show exactly what the page shows, and two
 * queries that are meant to agree eventually will not.
 *
 * Ownership is re-checked here on every request rather than trusting a signed token: a
 * leaked export link is a leaked case file (sitemap.md §7).
 */
export async function getWorkspaceForExport(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceDetail | null> {
  return getWorkspace(workspaceId, userId);
}

/** Ordering helper for the actions: the next `order_index` within a workspace and kind. */
export async function nextItemOrderIndex(
  workspaceId: string,
  kind: WorkspaceItemKind,
  client: Db = db,
): Promise<number> {
  const row = await client
    .select({ next: sql<number>`coalesce(max(${workspaceItems.orderIndex}) + 1, 0)::int` })
    .from(workspaceItems)
    .where(and(eq(workspaceItems.workspaceId, workspaceId), eq(workspaceItems.kind, kind)));
  return row[0]?.next ?? 0;
}

/** Workspaces started from a playbook, for the "resume" affordance. */
export async function listWorkspacesForPlaybook(
  playbookId: string,
  userId: string,
): Promise<{ id: string; title: string }[]> {
  return db
    .select({ id: workspaces.id, title: workspaces.title })
    .from(workspaces)
    .where(and(eq(workspaces.playbookId, playbookId), eq(workspaces.userId, userId)))
    .orderBy(asc(workspaces.createdAt));
}
