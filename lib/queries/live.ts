import { and, asc, eq, ilike, or, sql } from "drizzle-orm";

import {
  cameras,
  connectors,
  type CameraViewKind,
  type ConfidenceLevel,
  type Connector,
  type ConnectorKind,
} from "@/db/schema";
import { db, type Db } from "@/lib/db";
import { cameraCacheKey, type CameraFilters } from "@/lib/validation/filters";
import { TAG, TTL, cached, cachedByKey } from "./cache";

/**
 * Reads for the Live pillar (ADR 0011). Two kinds of thing live here:
 *
 *  - the CONNECTOR REGISTRY, which `lib/connectors/` reads before every outbound call. It is
 *    uncached: the kill-switch (`enabled`) exists so that a source whose terms change can be
 *    stopped without a deploy (ADR 0011 rule 6, ADR 0012 §1), and a cached registry would
 *    put a TTL between the operator flipping the switch and the calls stopping. One indexed
 *    read per surface render is the price of a kill-switch that actually kills.
 *  - the CAMERA REGISTRY, which is ordinary content held to the same editorial standard as
 *    `tools`, and is cached like any other content read.
 */

/* ------------------------------------------------------------------ *
 * Connector registry
 * ------------------------------------------------------------------ */

/**
 * The one connector that may serve a surface right now, or null.
 *
 * FOUR conditions, all of them fail-closed:
 *   - `status = 'published'` — editorial: it is part of the shipped product.
 *   - `enabled = true`       — operational: it may make a request right now. Defaults to
 *                              false, so a newly seeded connector is inert until an operator
 *                              turns it on (ADR 0012 §1).
 *   - `terms_url is not null` and `legal_basis is not null` — the runtime half of
 *     `connectors_published_requires_legal_basis_check`. ADR 0012's "alternatives
 *     considered" asks for this assertion *as well as* the constraint, and it is cheap:
 *     the constraint fails at write time in front of the person who caused it, this fails at
 *     request time before we call anyone.
 *
 * Served by `connectors_kind_status_enabled_idx`.
 */
export async function getLiveConnector(
  kind: ConnectorKind,
  client: Db = db,
): Promise<Connector | null> {
  const row = await client
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.kind, kind),
        eq(connectors.status, "published"),
        eq(connectors.enabled, true),
        sql`${connectors.termsUrl} is not null`,
        sql`${connectors.legalBasis} is not null`,
      ),
    )
    .orderBy(asc(connectors.slug))
    .limit(1);

  return row[0] ?? null;
}

/**
 * A connector by slug regardless of state, for the disabled/degraded surface: when a
 * connector is off we still render its operator and attribution and say plainly that it is
 * off (ADR 0014 §2), which needs the row.
 */
export async function getConnectorBySlug(
  slug: string,
  client: Db = db,
): Promise<Connector | null> {
  const row = await client.select().from(connectors).where(eq(connectors.slug, slug)).limit(1);
  return row[0] ?? null;
}

export type ConnectorPublicSummary = {
  slug: string;
  name: string;
  kind: ConnectorKind;
  operatorName: string;
  homepageUrl: string;
  termsUrl: string | null;
  attribution: string | null;
  attributionRequired: boolean;
  enabled: boolean;
  lastCheckedAt: Date | null;
};

/**
 * The published connectors, for the `/live` landing page — "which operators we draw on"
 * (sitemap.md §3).
 *
 * `legal_basis` and `notes` are NOT selected. They are internal editorial prose written by a
 * team with no lawyer (ADR 0012 consequences); the public statement is the operator, the
 * terms URL and the attribution.
 */
async function listPublishedConnectorsUncached(): Promise<ConnectorPublicSummary[]> {
  return db
    .select({
      slug: connectors.slug,
      name: connectors.name,
      kind: connectors.kind,
      operatorName: connectors.operatorName,
      homepageUrl: connectors.homepageUrl,
      termsUrl: connectors.termsUrl,
      attribution: connectors.attribution,
      attributionRequired: connectors.attributionRequired,
      enabled: connectors.enabled,
      lastCheckedAt: connectors.lastCheckedAt,
    })
    .from(connectors)
    .where(eq(connectors.status, "published"))
    .orderBy(asc(connectors.kind), asc(connectors.name));
}

export const listPublishedConnectors = cached(
  listPublishedConnectorsUncached,
  ["connectors-published"],
  { tags: [TAG.connectors], revalidate: TTL.hour },
);

/* ------------------------------------------------------------------ *
 * Camera registry
 * ------------------------------------------------------------------ */

export type CameraCard = {
  id: string;
  slug: string;
  name: string;
  operatorName: string;
  jurisdiction: string;
  locationLabel: string;
  viewKind: CameraViewKind;
  latitude: number;
  longitude: number;
  sourceUrl: string;
  embedPermitted: boolean;
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
  attribution: string | null;
};

/**
 * `/live/cameras`. ONE round trip, and — importantly — ZERO outbound requests: this renders
 * our own registry rows only (sitemap.md §3). Embeds are click-to-load (ADR 0015), so
 * nothing here may become a prefetch, a `<link rel=preconnect>` or a thumbnail grid.
 *
 * `embed_url` is deliberately NOT selected. The listing never embeds, so shipping the embed
 * URL to the browser would be handing out an origin the page has no business contacting.
 */
async function listCamerasUncached(filters: CameraFilters): Promise<CameraCard[]> {
  const conditions = [eq(cameras.status, "published")];

  if (filters.view) conditions.push(eq(cameras.viewKind, filters.view));
  if (filters.jurisdiction) {
    conditions.push(sql`lower(${cameras.jurisdiction}) = ${filters.jurisdiction}`);
  }
  if (filters.q) {
    // ILIKE, not full-text: `cameras` carries no `search_vector` (data-model.md §12) because
    // the registry's browse axes are geography and subject, both of which are columns, and
    // the whole published set is one cached query. A GIN index here would be ceremony.
    const pattern = `%${filters.q}%`;
    const match = or(
      ilike(cameras.name, pattern),
      ilike(cameras.locationLabel, pattern),
      ilike(cameras.operatorName, pattern),
    );
    if (match) conditions.push(match);
  }

  return db
    .select({
      id: cameras.id,
      slug: cameras.slug,
      name: cameras.name,
      operatorName: cameras.operatorName,
      jurisdiction: cameras.jurisdiction,
      locationLabel: cameras.locationLabel,
      viewKind: cameras.viewKind,
      latitude: cameras.latitude,
      longitude: cameras.longitude,
      sourceUrl: cameras.sourceUrl,
      embedPermitted: cameras.embedPermitted,
      confidence: cameras.confidence,
      lastVerifiedAt: cameras.lastVerifiedAt,
      attribution: cameras.attribution,
    })
    .from(cameras)
    .where(and(...conditions))
    .orderBy(asc(cameras.jurisdiction), asc(cameras.name));
}

export async function listCameras(filters: CameraFilters): Promise<CameraCard[]> {
  const key = cameraCacheKey(filters);
  return cached(async (_key: string) => listCamerasUncached(filters), ["cameras-list"], {
    tags: [TAG.cameras],
    revalidate: TTL.hour,
  })(key);
}

export type CameraDetail = CameraCard & {
  embedUrl: string | null;
  embedNotes: string | null;
  connector: {
    slug: string;
    name: string;
    operatorName: string;
    attribution: string | null;
    attributionRequired: boolean;
    enabled: boolean;
  } | null;
};

/**
 * `/live/cameras/[slug]`. Returns null for a draft or missing slug.
 *
 * `embedUrl` is present here because this is the page where a reader can choose to load the
 * feed — and only after an explicit click that discloses the outbound connection first
 * (ADR 0015). The connector is joined in because attribution renders next to the data, not
 * in a footer (ADR 0011 rule 2), and because a camera whose connector is disabled must show
 * the disabled state rather than an embed that will not load.
 */
async function getCameraBySlugUncached(slug: string): Promise<CameraDetail | null> {
  const row = await db.query.cameras.findFirst({
    where: and(eq(cameras.slug, slug), eq(cameras.status, "published")),
    with: {
      connector: {
        columns: {
          slug: true,
          name: true,
          operatorName: true,
          attribution: true,
          attributionRequired: true,
          enabled: true,
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    operatorName: row.operatorName,
    jurisdiction: row.jurisdiction,
    locationLabel: row.locationLabel,
    viewKind: row.viewKind,
    latitude: row.latitude,
    longitude: row.longitude,
    sourceUrl: row.sourceUrl,
    embedPermitted: row.embedPermitted,
    confidence: row.confidence,
    lastVerifiedAt: row.lastVerifiedAt,
    attribution: row.attribution,
    embedUrl: row.embedUrl,
    embedNotes: row.embedNotes,
    connector: row.connector ?? null,
  };
}

export const getCameraBySlug = cachedByKey(
  getCameraBySlugUncached,
  ["camera-by-slug"],
  (slug) => [TAG.cameras, TAG.camera(slug), TAG.connectors],
  TTL.hour,
);

/** Published camera slugs, for the sitemap. */
export async function listPublishedCameraSlugs(): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: cameras.slug, updatedAt: cameras.updatedAt })
    .from(cameras)
    .where(eq(cameras.status, "published"))
    .orderBy(asc(cameras.slug));
}
