import { sql } from "drizzle-orm";

import { playbooks, tools, type ConfidenceLevel } from "@/db/schema";
import { db } from "@/lib/db";
import { searchCacheKey, type SearchFilters } from "@/lib/validation/filters";
import { TAG, TTL, cached } from "./cache";

/**
 * Postgres full-text search. `docs/architecture/search.md` is the specification; this file
 * is the implementation of §6.
 *
 * Every query here is raw SQL through the Drizzle `sql` tag, because none of
 * `websearch_to_tsquery`, `ts_rank_cd`, `@@` or `similarity()` has a builder equivalent.
 * Every value is a bound parameter.
 *
 * THREE things that look like details and are not:
 *
 *  - `websearch_to_tsquery`, never `to_tsquery`. It accepts what people actually type —
 *    quoted phrases, `or`, a leading `-` for negation — and it NEVER raises on malformed
 *    input. `to_tsquery` turns `foo &` into a 500; a search box that can be crashed by
 *    punctuation is a bug report waiting to happen.
 *  - `ts_rank_cd(vector, query, 32)`. Cover density, normalised `rank/(rank+1)` into (0,1),
 *    so a long description cannot accumulate score by length alone.
 *  - `confidence` is NOT a ranking input (ADR 0007 §6). Down-ranking `needsReview` would
 *    bury exactly the entries a reader most needs to approach sceptically, and would turn a
 *    transparency field into a silent editorial filter.
 */

export const SEARCH_PAGE_SIZE = 20;

export type ToolHit = {
  slug: string;
  name: string;
  summary: string;
  confidence: ConfidenceLevel;
  reliability: number | null;
  lastVerifiedAt: Date | null;
  rank: number;
};

export type PlaybookHit = {
  slug: string;
  title: string;
  summary: string;
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
  rank: number;
};

export type FuzzyHit = { slug: string; name: string; summary: string; similarity: number };

export type SearchResults = {
  query: string;
  tools: ToolHit[];
  playbooks: PlaybookHit[];
  /**
   * Populated ONLY when both ranked groups are empty. search.md §5: the fallback fires when
   * the tsquery returns zero rows and is never merged into the primary result set — mixing
   * a rank scale with a similarity scale produces rankings nobody can explain, and this
   * product's whole proposition is being explainable.
   *
   * The UI presents this as "No exact matches. Did you mean:", never as ordinary results.
   */
  didYouMean: FuzzyHit[];
  toolTotal: number;
  playbookTotal: number;
  page: number;
  pageSize: number;
};

/** search.md §6.1. Ordering is total, so a row cannot swap between pages. */
async function searchToolsUncached(
  query: string,
  limit: number,
  offset: number,
): Promise<{ hits: ToolHit[]; total: number }> {
  const rows = await db.execute<{
    slug: string;
    name: string;
    summary: string;
    confidence: ConfidenceLevel;
    reliability: number | null;
    last_verified_at: Date | null;
    rank: number;
    total_count: string;
  }>(sql`
    with q as (select websearch_to_tsquery('english', ${query}) as query)
    select t.slug,
           t.name,
           t.summary,
           t.confidence,
           t.reliability,
           t.last_verified_at,
           ts_rank_cd(t.search_vector, q.query, 32) as rank,
           count(*) over () as total_count
    from ${tools} t, q
    where t.status = ${"published"}
      and t.search_vector @@ q.query
    order by rank desc, t.reliability desc nulls last, t.name asc
    limit ${limit} offset ${offset}
  `);

  return {
    hits: rows.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      confidence: row.confidence,
      reliability: row.reliability,
      lastVerifiedAt: row.last_verified_at,
      rank: Number(row.rank),
    })),
    total: rows.rows[0] ? Number(rows.rows[0].total_count) : 0,
  };
}

/** search.md §6.2. Playbooks have no reliability rating, so the tiebreak is title alone. */
async function searchPlaybooksUncached(
  query: string,
  limit: number,
  offset: number,
): Promise<{ hits: PlaybookHit[]; total: number }> {
  const rows = await db.execute<{
    slug: string;
    title: string;
    summary: string;
    confidence: ConfidenceLevel;
    last_verified_at: Date | null;
    rank: number;
    total_count: string;
  }>(sql`
    with q as (select websearch_to_tsquery('english', ${query}) as query)
    select p.slug,
           p.title,
           p.summary,
           p.confidence,
           p.last_verified_at,
           ts_rank_cd(p.search_vector, q.query, 32) as rank,
           count(*) over () as total_count
    from ${playbooks} p, q
    where p.status = ${"published"}
      and p.search_vector @@ q.query
    order by rank desc, p.title asc
    limit ${limit} offset ${offset}
  `);

  return {
    hits: rows.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      confidence: row.confidence,
      lastVerifiedAt: row.last_verified_at,
      rank: Number(row.rank),
    })),
    total: rows.rows[0] ? Number(rows.rows[0].total_count) : 0,
  };
}

/**
 * search.md §6.4 — the `pg_trgm` fallback.
 *
 * The 0.3 threshold is written into the predicate rather than set through
 * `pg_trgm.similarity_threshold`, because that GUC is connection state and this application
 * uses a pool: the value a query sees would depend on which pooled connection served it.
 * In the predicate it is visible in the query and identical everywhere.
 */
async function fuzzyToolsUncached(query: string): Promise<FuzzyHit[]> {
  const rows = await db.execute<{
    slug: string;
    name: string;
    summary: string;
    sim: number;
  }>(sql`
    select slug, name, summary, similarity(name, ${query}) as sim
    from ${tools}
    where status = ${"published"} and similarity(name, ${query}) > 0.3
    order by sim desc, name asc
    limit 10
  `);

  return rows.rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    similarity: Number(row.sim),
  }));
}

/**
 * `/search` — both groups, queried independently and merged in the UI, never in SQL
 * (search.md §1). A `UNION` would force one ranking scale across two corpora with very
 * different document lengths.
 *
 * ROUND TRIPS: 2 in the ordinary case, run concurrently; 3 when both groups are empty and
 * the fuzzy fallback fires. Zero when the query is empty.
 */
async function searchUncached(filters: SearchFilters): Promise<SearchResults> {
  const offset = (filters.page - 1) * SEARCH_PAGE_SIZE;

  const empty: SearchResults = {
    query: filters.q,
    tools: [],
    playbooks: [],
    didYouMean: [],
    toolTotal: 0,
    playbookTotal: 0,
    page: filters.page,
    pageSize: SEARCH_PAGE_SIZE,
  };

  if (!filters.q) return empty;

  const [toolResults, playbookResults] = await Promise.all([
    searchToolsUncached(filters.q, SEARCH_PAGE_SIZE, offset),
    searchPlaybooksUncached(filters.q, SEARCH_PAGE_SIZE, offset),
  ]);

  const didYouMean =
    toolResults.total === 0 && playbookResults.total === 0
      ? await fuzzyToolsUncached(filters.q)
      : [];

  return {
    query: filters.q,
    tools: toolResults.hits,
    playbooks: playbookResults.hits,
    didYouMean,
    toolTotal: toolResults.total,
    playbookTotal: playbookResults.total,
    page: filters.page,
    pageSize: SEARCH_PAGE_SIZE,
  };
}

/**
 * `revalidate: 60`, not an hour. Search results are the one public surface where an hour of
 * staleness is noticeable and a minute is not (caching.md §6).
 */
export async function search(filters: SearchFilters): Promise<SearchResults> {
  const key = searchCacheKey(filters);
  return cached(async (_key: string) => searchUncached(filters), ["search"], {
    tags: [TAG.search, TAG.tools, TAG.playbooks],
    revalidate: TTL.minute,
  })(key);
}

/**
 * `/api/search/suggest` — the type-ahead. search.md §6.5.
 *
 * NOT cached, at any layer. A shared cache of partial search queries, keyed by prefix and
 * warmed by whoever typed first, is a readable log of what this audience is looking into.
 * caching.md §7 is explicit that product-brief §3.2 constraint 4 covers our own
 * infrastructure and not only third-party trackers.
 *
 * The route handler rate-limits this per hashed client identifier before calling it.
 */
export async function suggest(query: string): Promise<{ slug: string; name: string }[]> {
  const rows = await db.execute<{ slug: string; name: string }>(sql`
    with q as (select websearch_to_tsquery('english', ${query}) as query)
    select t.slug, t.name
    from ${tools} t, q
    where t.status = ${"published"}
      and t.search_vector @@ q.query
    order by ts_rank_cd(t.search_vector, q.query, 32) desc,
             t.reliability desc nulls last,
             t.name asc
    limit 8
  `);
  return rows.rows;
}
