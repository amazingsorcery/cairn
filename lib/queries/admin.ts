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
 * Editorial reads. Uncached (`/admin` is `force-dynamic`) and include drafts. Callers must
 * run `requireEditor()` / `requireAdmin()` first; these don't check roles.
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
 * `/admin/queue`: the staleness queue. Four concurrent queries rather than a `UNION ALL`, so
 * each uses its own `*_confidence_verified_idx`. `NULLS FIRST`: never-verified sorts to the top.
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
    // Connectors: stale terms are a legal risk. No `confidence`, just `last_checked_at`.
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

/** `/admin/tools`: every tool, drafts included, newest edit first. */
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

/** Playbook, steps and step tool links in one relational query. */
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

/** `/admin/connectors` (admin only), drafts and disabled included. */
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
  /** Outbound HTTP requests (what the upstream sees; one attempt may make several). */
  outboundRequests: number;
  byOutcome: Record<ConnectorRequestOutcome, number>;
  /** p95 latency in ms (`percentile_disc` over the window). */
  p95DurationMs: number | null;
};

/** A zero count for every outcome, derived from the vocabulary so new outcomes appear. */
function zeroedOutcomes(): Record<ConnectorRequestOutcome, number> {
  return Object.fromEntries(CONNECTOR_REQUEST_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    ConnectorRequestOutcome,
    number
  >;
}

/**
 * Connector health board for `/admin/connectors`. Failure, quota and latency only; no
 * `actor_key`. Uses `connector_requests_connector_time_idx`.
 */
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

    // Null `outcome` = no traffic in the window; still listed.
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

/** Audit log row count and oldest row, so operators can see the retention sweep is running. */
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
