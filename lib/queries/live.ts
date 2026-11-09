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
 * Live pillar reads:
 *  - Connector registry: read before every outbound call; uncached so the kill-switch takes
 *    effect immediately.
 *  - Camera registry: ordinary content, cached.
 */

/* ------------------------------------------------------------------ *
 * Connector registry
 * ------------------------------------------------------------------ */

/**
 * The connector that may serve a surface right now, or null. Requires published, enabled
 * (defaults to false), and non-null terms URL and legal basis (runtime echo of the DB
 * constraint). Uses `connectors_kind_status_enabled_idx`.
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

/** A connector by slug in any state, so a disabled source can still show its operator. */
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
 * Published connectors for the `/live` landing page. `legal_basis` and `notes` are internal
 * and not selected.
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
 * `/live/cameras`: registry rows only, no outbound requests (embeds are click-to-load).
 * `embed_url` isn't selected since the listing never embeds.
 */
async function listCamerasUncached(filters: CameraFilters): Promise<CameraCard[]> {
  const conditions = [eq(cameras.status, "published")];

  if (filters.view) conditions.push(eq(cameras.viewKind, filters.view));
  if (filters.jurisdiction) {
    conditions.push(sql`lower(${cameras.jurisdiction}) = ${filters.jurisdiction}`);
  }
  if (filters.q) {
    // ILIKE: `cameras` has no `search_vector`; the set is small and cached.
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
 * `/live/cameras/[slug]`, or null for a draft or missing slug. Includes `embedUrl` (loaded only
 * after a disclosed click) and the connector, for attribution and disabled state.
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
