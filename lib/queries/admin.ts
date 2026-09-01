import { asc, desc, eq, gte, sql } from "drizzle-orm";

import {
  cameras,
  CONNECTOR_REQUEST_OUTCOMES,
  connectorRequests,
  connectors,
  playbooks,
  tools,
  type ConfidenceLevel,
  type ConnectorRequestOutcome,
  type PublicationStatus,
} from "@/db/schema";
import { db } from "@/lib/db";

/**
 * The editorial surface. NOTHING here is cached (caching.md §7: everything under `/admin` is
 * `force-dynamic`), and every function is called only after `requireEditor()` or
 * `requireAdmin()` in the route or action. These functions do not check the role themselves:
 * they are the data layer, and a query that silently returns nothing for the wrong role
 * hides an authorisation bug instead of surfacing it.
 *
 * Unlike everything in `tools.ts` and `playbooks.ts`, these reads see DRAFTS. That is the
 * point of `/admin`: it is the only preview path (HANDOFF §7).
 */

export type QueueEntry = {
  kind: "tool" | "playbook" | "camera" | "connector";
  id: string;
  slug: string;
  title: string;
  status: PublicationStatus;
  confidence: ConfidenceLevel | null;
  /** `last_verified_at` for content, `last_checked_at` for a connector. */
  lastVerifiedAt: Date | null;
};

/**
 * `/admin/queue` — the staleness queue. ADR 0007 §7 and ADR 0012.
 *
 * "Without a route that makes decay visible to an editor, `lastVerifiedAt` becomes a fossil
 * within a quarter." This is that route's data.
 *
 * FOUR round trips, run concurrently — one per entity type. They are not `UNION ALL`ed into
 * one statement because that would force a common column list across four differently
 * shaped tables and, more importantly, would defeat the four separate indexes
 * (`tools_confidence_verified_idx` and its siblings) that make each ordering cheap.
 *
 * `NULLS FIRST` on the date is deliberate: never verified is worse than verified long ago,
 * and it must sort to the top rather than to the bottom of a list nobody scrolls.
 */
export async function getVerificationQueue(): Promise<QueueEntry[]> {
  const [toolRows, playbookRows, cameraRows, connectorRows] = await Promise.all([
    db
      .select({
        id: tools.id,
        slug: tools.slug,
        title: tools.name,
        status: tools.status,
        confidence: tools.confidence,
        lastVerifiedAt: tools.lastVerifiedAt,
      })
      .from(tools)
      .orderBy(asc(tools.confidence), sql`${tools.lastVerifiedAt} asc nulls first`),
    db
      .select({
        id: playbooks.id,
        slug: playbooks.slug,
        title: playbooks.title,
        status: playbooks.status,
        confidence: playbooks.confidence,
        lastVerifiedAt: playbooks.lastVerifiedAt,
      })
      .from(playbooks)
      .orderBy(asc(playbooks.confidence), sql`${playbooks.lastVerifiedAt} asc nulls first`),
    db
      .select({
        id: cameras.id,
        slug: cameras.slug,
        title: cameras.name,
        status: cameras.status,
        confidence: cameras.confidence,
        lastVerifiedAt: cameras.lastVerifiedAt,
      })
      .from(cameras)
      .orderBy(asc(cameras.confidence), sql`${cameras.lastVerifiedAt} asc nulls first`),
    /**
     * Connectors join the queue because "a connector whose terms were last read fourteen
     * months ago is a live legal risk" (ADR 0012). They carry no `confidence` column — the
     * editorial question for a connector is only "when did a human last read the terms".
     */
    db
      .select({
        id: connectors.id,
        slug: connectors.slug,
        title: connectors.name,
        status: connectors.status,
        lastVerifiedAt: connectors.lastCheckedAt,
      })
      .from(connectors)
      .orderBy(sql`${connectors.lastCheckedAt} asc nulls first`),
  ]);

  return [
    ...toolRows.map((r) => ({ ...r, kind: "tool" as const })),
    ...playbookRows.map((r) => ({ ...r, kind: "playbook" as const })),
    ...cameraRows.map((r) => ({ ...r, kind: "camera" as const })),
    ...connectorRows.map((r) => ({ ...r, kind: "connector" as const, confidence: null })),
  ];
}

/** `/admin/tools` — every tool, drafts included, newest edit first. ONE round trip. */
export async function listToolsForAdmin() {
  return db
    .select({
      id: tools.id,
      slug: tools.slug,
      name: tools.name,
      status: tools.status,
      confidence: tools.confidence,
      reliability: tools.reliability,
      lastVerifiedAt: tools.lastVerifiedAt,
      updatedAt: tools.updatedAt,
    })
    .from(tools)
    .orderBy(desc(tools.updatedAt));
}

/** `/admin/tools/[id]` — the preview and edit path. Drafts included, by id not slug. */
export async function getToolForAdmin(id: string) {
  const row = await db.query.tools.findFirst({
    where: eq(tools.id, id),
    with: {
      category: { columns: { id: true, slug: true, name: true } },
      toolTags: { with: { tag: { columns: { id: true, slug: true, name: true } } } },
    },
  });
  return row ?? null;
}

export async function listPlaybooksForAdmin() {
  return db
    .select({
      id: playbooks.id,
      slug: playbooks.slug,
      title: playbooks.title,
      status: playbooks.status,
      confidence: playbooks.confidence,
      lastVerifiedAt: playbooks.lastVerifiedAt,
      updatedAt: playbooks.updatedAt,
    })
    .from(playbooks)
    .orderBy(desc(playbooks.updatedAt));
}

/** ONE round trip — playbook, steps, step tool links, in a single relational statement. */
export async function getPlaybookForAdmin(id: string) {
  const row = await db.query.playbooks.findFirst({
    where: eq(playbooks.id, id),
    with: {
      category: { columns: { id: true, slug: true, name: true } },
      steps: {
        with: { toolLinks: { with: { tool: { columns: { id: true, slug: true, name: true } } } } },
      },
    },
  });
  if (!row) return null;
  return { ...row, steps: [...row.steps].sort((a, b) => a.orderIndex - b.orderIndex) };
}

export async function listCamerasForAdmin() {
  return db
    .select({
      id: cameras.id,
      slug: cameras.slug,
      name: cameras.name,
      status: cameras.status,
      jurisdiction: cameras.jurisdiction,
      viewKind: cameras.viewKind,
      embedPermitted: cameras.embedPermitted,
      confidence: cameras.confidence,
      lastVerifiedAt: cameras.lastVerifiedAt,
      updatedAt: cameras.updatedAt,
    })
    .from(cameras)
    .orderBy(desc(cameras.updatedAt));
}

/** `/admin/connectors` — admin role only (sitemap.md §8), drafts and disabled included. */
export async function listConnectorsForAdmin() {
  return db.select().from(connectors).orderBy(asc(connectors.kind), asc(connectors.name));
}

export type ConnectorHealth = {
  connectorId: string;
  slug: string;
  name: string;
  enabled: boolean;
  windowHours: number;
  /** Governed attempts in the window — one per `runConnector` or `pollSource` call. */
  total: number;
  /**
   * OUTBOUND HTTP REQUESTS in the window, which is not the same number. QA finding QV-09.
   *
   * The DNS driver makes six requests per lookup and RIPEstat four, so a board showing
   * `total` alone said 20 where Cloudflare saw 120. The two are shown side by side rather
   * than one replacing the other: `total` is what our quotas count, this is what the upstream
   * counts, and an operator arguing fair use needs the second one.
   */
  outboundRequests: number;
  byOutcome: Record<ConnectorRequestOutcome, number>;
  /**
   * Approximate 95th-percentile latency over the window, in milliseconds. `percentile_disc`
   * over the whole window rather than a sampled estimate — the row count here is small.
   */
  p95DurationMs: number | null;
};

/**
 * The connector health board on `/admin/connectors` (sitemap.md §8).
 *
 * ONE round trip. It answers exactly the questions ADR 0013 says the audit log is for — is
 * this connector failing, how often are we quota-denied, how slow is upstream — and it
 * CANNOT answer "who looked at what", because that data is not in the table. There is no
 * `actor_key` in this projection and no index on it (ADR 0013 §3).
 *
 * Served by `connector_requests_connector_time_idx`.
 */
/**
 * A zeroed count for every outcome, DERIVED from the vocabulary rather than typed out.
 *
 * The hand-written literal this replaces silently lost a member when `rateLimited` was added
 * (migration 0005): the board would have shown a connector being refused by its upstream and
 * counted it nowhere. Deriving means a seventh outcome appears on the board with a zero
 * rather than being dropped.
 */
function zeroedOutcomes(): Record<ConnectorRequestOutcome, number> {
  return Object.fromEntries(CONNECTOR_REQUEST_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    ConnectorRequestOutcome,
    number
  >;
}

export async function getConnectorHealth(windowHours = 24): Promise<ConnectorHealth[]> {
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const rows = await db
    .select({
      connectorId: connectors.id,
      slug: connectors.slug,
      name: connectors.name,
      enabled: connectors.enabled,
      outcome: connectorRequests.outcome,
      count: sql<number>`count(*)::int`,
      outbound: sql<number>`coalesce(sum(${connectorRequests.upstreamRequests}), 0)::int`,
      p95: sql<
        number | null
      >`percentile_disc(0.95) within group (order by ${connectorRequests.durationMs})`,
    })
    .from(connectors)
    .leftJoin(
      connectorRequests,
      sql`${connectorRequests.connectorId} = ${connectors.id} and ${connectorRequests.requestedAt} >= ${since}`,
    )
    .groupBy(
      connectors.id,
      connectors.slug,
      connectors.name,
      connectors.enabled,
      connectorRequests.outcome,
    );

  const byConnector = new Map<string, ConnectorHealth>();

  for (const row of rows) {
    const existing = byConnector.get(row.connectorId) ?? {
      connectorId: row.connectorId,
      slug: row.slug,
      name: row.name,
      enabled: row.enabled,
      windowHours,
      total: 0,
      outboundRequests: 0,
      byOutcome: zeroedOutcomes(),
      p95DurationMs: null,
    };

    // `outcome` is null on the LEFT JOIN miss — a connector with no traffic in the window,
    // which must still appear on the board rather than vanishing from it.
    if (row.outcome) {
      existing.byOutcome[row.outcome] += row.count;
      existing.total += row.count;
      existing.outboundRequests += Number(row.outbound);
      const p95 = row.p95 === null ? null : Number(row.p95);
      if (p95 !== null && (existing.p95DurationMs === null || p95 > existing.p95DurationMs)) {
        existing.p95DurationMs = p95;
      }
    }

    byConnector.set(row.connectorId, existing);
  }

  return [...byConnector.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rows retained in the audit log right now, and the oldest one. Surfaced on
 * `/admin/connectors` so an operator can see at a glance whether the retention sweep is
 * actually running — an unswept `connector_requests` is both a disk failure on a small VPS
 * and a slowly accumulating record of the kind ADR 0013 exists to prevent.
 */
export async function getAuditLogSize(): Promise<{ rows: number; oldest: Date | null }> {
  const result = await db
    .select({
      rows: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${connectorRequests.requestedAt})`,
    })
    .from(connectorRequests)
    .where(gte(connectorRequests.requestedAt, new Date(0)));

  return { rows: result[0]?.rows ?? 0, oldest: result[0]?.oldest ?? null };
}
