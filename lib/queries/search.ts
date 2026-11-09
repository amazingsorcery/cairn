import { sql } from "drizzle-orm";

import { playbooks, tools, type ConfidenceLevel } from "@/db/schema";
import { db } from "@/lib/db";
import { searchCacheKey, type SearchFilters } from "@/lib/validation/filters";
import { TAG, TTL, cached } from "./cache";

/**
 * Postgres full-text search. Raw SQL (no builder equivalents for these functions); all
 * values are bound.
 *
 *  - `websearch_to_tsquery`, never `to_tsquery`: it never raises on malformed input.
 *  - `ts_rank_cd(vector, query, 32)`: cover density normalised to (0,1), so length doesn't
 *    inflate score.
 *  - `confidence` is not a ranking input; it's shown, not used to filter.
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
   * Only when both ranked groups are empty; never mixed with ranked results (different
   * scales). Shown as "Did you mean:".
   */
  didYouMean: FuzzyHit[];
  toolTotal: number;
  playbookTotal: number;
  page: number;
  pageSize: number;
};

/** Ordering is total, so a row can't swap between pages. */
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

/** Playbooks have no reliability rating, so the tiebreak is title alone. */
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
 * `pg_trgm` fallback. The 0.3 threshold is in the predicate, not the
 * `pg_trgm.similarity_threshold` GUC, which is per-connection state in a pool.
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
 * One ranked group with its own total. Tools and playbooks are queried separately (no
 * `UNION`: different ranking scales) so a caller can use `Promise.allSettled` and render one
 * group if the other fails.
 */
export type SearchGroup<Hit> = {
  hits: Hit[];
  total: number;
  page: number;
  pageSize: number;
};

/** The tools group, cached independently of playbooks. */
export async function searchTools(filters: SearchFilters): Promise<SearchGroup<ToolHit>> {
  const empty = { hits: [], total: 0, page: filters.page, pageSize: SEARCH_PAGE_SIZE };
  if (!filters.q) return empty;

  const offset = (filters.page - 1) * SEARCH_PAGE_SIZE;
  const key = `tools:${searchCacheKey(filters)}`;

  return cached(
    async (_key: string) => {
      const { hits, total } = await searchToolsUncached(filters.q, SEARCH_PAGE_SIZE, offset);
      return { hits, total, page: filters.page, pageSize: SEARCH_PAGE_SIZE };
    },
    ["search-tools"],
    { tags: [TAG.search, TAG.tools], revalidate: TTL.minute },
  )(key);
}

/** The playbooks group. */
export async function searchPlaybooks(
  filters: SearchFilters,
): Promise<SearchGroup<PlaybookHit>> {
  const empty = { hits: [], total: 0, page: filters.page, pageSize: SEARCH_PAGE_SIZE };
  if (!filters.q) return empty;

  const offset = (filters.page - 1) * SEARCH_PAGE_SIZE;
  const key = `playbooks:${searchCacheKey(filters)}`;

  return cached(
    async (_key: string) => {
      const { hits, total } = await searchPlaybooksUncached(filters.q, SEARCH_PAGE_SIZE, offset);
      return { hits, total, page: filters.page, pageSize: SEARCH_PAGE_SIZE };
    },
    ["search-playbooks"],
    { tags: [TAG.search, TAG.playbooks], revalidate: TTL.minute },
  )(key);
}

/**
 * Trigram fallback. Call only when both groups returned zero rows; not when one failed.
 */
export async function didYouMean(query: string): Promise<FuzzyHit[]> {
  if (!query) return [];
  return cached(async (_key: string) => fuzzyToolsUncached(query), ["search-did-you-mean"], {
    tags: [TAG.search, TAG.tools],
    revalidate: TTL.minute,
  })(query);
}

/** Both groups plus the fallback. Cached for a minute. */
export async function search(filters: SearchFilters): Promise<SearchResults> {
  const base = {
    query: filters.q,
    page: filters.page,
    pageSize: SEARCH_PAGE_SIZE,
  };

  if (!filters.q) {
    return { ...base, tools: [], playbooks: [], didYouMean: [], toolTotal: 0, playbookTotal: 0 };
  }

  const [toolGroup, playbookGroup] = await Promise.all([
    searchTools(filters),
    searchPlaybooks(filters),
  ]);

  // Only when both groups are empty.
  const fallback =
    toolGroup.total === 0 && playbookGroup.total === 0 ? await didYouMean(filters.q) : [];

  return {
    ...base,
    tools: toolGroup.hits,
    playbooks: playbookGroup.hits,
    didYouMean: fallback,
    toolTotal: toolGroup.total,
    playbookTotal: playbookGroup.total,
  };
}

/**
 * `/api/search/suggest` type-ahead. Not cached: a prefix cache would be a log of what people
 * search for. The route handler rate-limits it.
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
