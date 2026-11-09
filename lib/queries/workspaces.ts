import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  notes,
  playbooks,
  workspaceItems,
  workspaces,
  type ConfidenceLevel,
  type SourceKind,
  type WorkspaceItemKind,
  type WorkspaceStatus,
} from "@/db/schema";
import { db, type Db } from "@/lib/db";
import {
  unpackSnapshotProperties,
  type SavedPrecision,
} from "@/lib/validation/workspaces";

/**
 * `db.execute` returns raw `pg` rows, skipping Drizzle's `timestamptz` -> `Date` mapping, so
 * timestamps may arrive as strings.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Signed-in reads. Nothing here is cached (every function takes a `userId`); don't import
 * `./cache`.
 *
 * Ownership is a SQL predicate (`where id = $1 and user_id = $2`), never fetch-then-compare.
 * Non-owners get null -> 404, never 403.
 *
 * `user_id` is denormalised onto items and notes so the predicate needs no join; workspaces
 * never change owner.
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
 * `/workspaces`: the user's list. Counts are correlated subqueries, since two one-to-many
 * joins would multiply. `userId` comes from the session.
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
  /** Snapshot taken when the item was saved. Never refreshed. */
  title: string;
  orderIndex: number;
  checked: boolean;
  checkedAt: Date | null;
  createdAt: Date;
  /** Null when the tool was deleted or unpublished; the UI renders plain text. */
  toolSlug: string | null;
  /**
   * The tool's current confidence and verification date (not snapshots), joined rather than
   * fetched per row. Null whenever `toolSlug` is.
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

/**
 * A saved live feature: `workspace_items` joined to its snapshot. Every field is copied at
 * save time and never refreshed (upstreams keep no history). Attribution and licence are
 * stored on the row since the connector may change later.
 */
export type WorkspaceFeatureView = {
  /** The `workspace_items` id, so removing one is the same action as removing a saved tool. */
  id: string;
  /** Snapshotted from the feature's label at save. */
  title: string;
  orderIndex: number;
  /** When the READER saved it. */
  savedAt: Date;
  sourceSlug: string;
  sourceName: string;
  sourceKind: SourceKind;
  featureRef: string;
  latitude: number;
  longitude: number;
  altitudeMetres: number | null;
  /** When the UPSTREAM observed it. */
  observedAt: Date;
  sourceUrl: string | null;
  attribution: string;
  licence: string;
  properties: Readonly<Record<string, string | number | boolean | null>>;
  /** Caveat when the coordinate is approximate; null for the source's own position. */
  precision: SavedPrecision | null;
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
  savedFeatures: WorkspaceFeatureView[];
  notes: NoteView[];
};

/**
 * `/workspaces/[id]`: the workspace (ownership-checked), then items and notes concurrently.
 * Items and notes also filter on `user_id` as defence in depth.
 */
export async function getWorkspace(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceDetail | null> {
  const workspace = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)),
    with: { playbook: { columns: { slug: true, title: true } } },
  });

  // Not found and not yours are the same answer.
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
      source_slug: string | null;
      source_name: string | null;
      source_kind: SourceKind | null;
      feature_ref: string | null;
      latitude: number | null;
      longitude: number | null;
      altitude_metres: number | null;
      observed_at: Date | string | null;
      source_url: string | null;
      attribution: string | null;
      licence: string | null;
      properties: unknown;
    }>(sql`
      select i.id,
             i.kind,
             i.title,
             i.order_index,
             i.checked,
             i.checked_at,
             i.created_at,
             i.tool_id,
             -- Null for an unpublished or deleted tool (rendered as plain text).
             case when t.status = 'published' then t.slug end as tool_slug,
             case when t.status = 'published' then t.confidence end as tool_confidence,
             case when t.status = 'published' then t.last_verified_at end as tool_last_verified_at,
             i.step_id,
             s.order_index as step_order_index,
             case when pb.status = 'published' then pb.slug end as playbook_slug,
             -- Map feature snapshot; null for other kinds.
             fs.source_slug,
             fs.source_name,
             fs.source_kind,
             fs.feature_ref,
             fs.latitude,
             fs.longitude,
             fs.altitude_metres,
             fs.observed_at,
             fs.source_url,
             fs.attribution,
             fs.licence,
             fs.properties
      from ${workspaceItems} i
      left join tools t on t.id = i.tool_id
      left join playbook_steps s on s.id = i.step_id
      left join playbooks pb on pb.id = s.playbook_id
      -- The snapshot's PK is this FK, so the join adds no rows.
      left join workspace_feature_snapshots fs on fs.workspace_item_id = i.id
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

  // A mapFeature without a snapshot shouldn't exist, but skip it rather than render it half-built.
  const savedFeatures: WorkspaceFeatureView[] = items.rows
    .filter((row) => row.kind === "mapFeature" && row.source_slug !== null)
    .map((row) => {
      const { properties, precision } = unpackSnapshotProperties(row.properties);
      return {
        id: row.id,
        title: row.title,
        orderIndex: row.order_index,
        savedAt: toDate(row.created_at),
        sourceSlug: row.source_slug ?? "",
        sourceName: row.source_name ?? "",
        sourceKind: (row.source_kind ?? "infrastructure") as SourceKind,
        featureRef: row.feature_ref ?? "",
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        altitudeMetres: row.altitude_metres === null ? null : Number(row.altitude_metres),
        observedAt: toDate(row.observed_at ?? row.created_at),
        sourceUrl: row.source_url,
        attribution: row.attribution ?? "",
        licence: row.licence ?? "",
        properties,
        precision,
      };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

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
    savedFeatures,
    notes: noteRows,
  };
}

/**
 * Ownership check for actions. Returns only the id. Accepts a transaction so the check and
 * write are atomic.
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

/** Ownership of an item via the denormalised `user_id`, in one statement. */
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
 * Data for `/workspaces/[id]/export`: same as `getWorkspace` so export matches the page.
 * Ownership is checked per request rather than via a signed link.
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
