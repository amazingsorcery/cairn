import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  categories,
  playbookStepTools,
  playbookSteps,
  playbooks,
  tags,
  toolTags,
  tools,
  type ConfidenceLevel,
  type CostModel,
} from "@/db/schema";
import { db } from "@/lib/db";
import type { DirectoryFilters } from "@/lib/validation/filters";
import { directoryCacheKey } from "@/lib/validation/filters";
import { TAG, TTL, cached, cachedByKey } from "./cache";

/**
 * The directory read layer.
 *
 * TWO RULES apply to everything in this file:
 *
 *  1. **Public reads filter `status = 'published'`.** A draft 404s for anonymous visitors;
 *     the only preview path is `/admin/tools/[id]` (HANDOFF §7). Every exported function
 *     here is a public read and carries that predicate. The admin reads live in `admin.ts`.
 *  2. **No N+1.** A list view is one query. Tag names come back as an aggregated array in
 *     the same statement rather than a lookup per row — with ~40 rows a page, the loop would
 *     be 41 round trips.
 */

export type ToolCard = {
  id: string;
  slug: string;
  name: string;
  url: string;
  summary: string;
  costModel: CostModel;
  jurisdiction: string | null;
  confidence: ConfidenceLevel;
  reliability: number | null;
  lastVerifiedAt: Date | null;
  categorySlug: string;
  categoryName: string;
  inputTypes: string[];
  outputTypes: string[];
  tagSlugs: string[];
  tagNames: string[];
};

export type ToolListPage = {
  items: ToolCard[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export const DIRECTORY_PAGE_SIZE = 24;

type DirectoryRow = {
  id: string;
  slug: string;
  name: string;
  url: string;
  summary: string;
  cost_model: CostModel;
  jurisdiction: string | null;
  confidence: ConfidenceLevel;
  reliability: number | null;
  last_verified_at: Date | null;
  category_slug: string;
  category_name: string;
  input_types: string[];
  output_types: string[];
  tag_slugs: string[] | null;
  tag_names: string[] | null;
  total_count: string;
};

function toCard(row: DirectoryRow): ToolCard {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    summary: row.summary,
    costModel: row.cost_model,
    jurisdiction: row.jurisdiction,
    confidence: row.confidence,
    reliability: row.reliability,
    lastVerifiedAt: row.last_verified_at,
    categorySlug: row.category_slug,
    categoryName: row.category_name,
    inputTypes: row.input_types,
    outputTypes: row.output_types,
    tagSlugs: row.tag_slugs ?? [],
    tagNames: row.tag_names ?? [],
  };
}

/**
 * `/directory` — the filtered, paginated tool list. `search.md` §6.3.
 *
 * ONE ROUND TRIP for the whole page, including the total. Three things make that true:
 *
 *  - Tag slugs and names arrive as arrays from a LATERAL subquery, not from a join. A join
 *    would multiply the tool rows by their tag count and force a GROUP BY over every
 *    selected column; a per-row lookup would be the N+1.
 *  - `count(*) OVER ()` returns the unfiltered-by-LIMIT total on every row, so pagination
 *    needs no second `SELECT count(*)` with the predicate duplicated (and the duplicate is
 *    where the two eventually disagree).
 *  - Each filter is `$n IS NULL OR <predicate>`, so one prepared statement shape serves
 *    every combination and Postgres still picks the GIN index when `q` is present
 *    (search.md §6.3 — "Do not hand-force a plan").
 *
 * Raw SQL through the `sql` tag, because Drizzle's query builder cannot express
 * `ts_rank_cd`, `websearch_to_tsquery`, `count(*) OVER ()` or the LATERAL aggregate. Every
 * value below is a bound parameter; nothing is string-concatenated.
 */
async function listToolsUncached(filters: DirectoryFilters): Promise<ToolListPage> {
  const offset = (filters.page - 1) * DIRECTORY_PAGE_SIZE;

  // Empty arrays become NULL so the `$n IS NULL OR …` short-circuit fires. An empty
  // `text[]` would make `@> '{}'` true for every row — correct, but it would also stop the
  // planner from skipping the containment test entirely.
  const q = filters.q || null;
  const category = filters.category ?? null;
  const tagList = filters.tags.length > 0 ? filters.tags : null;
  const costList = filters.cost.length > 0 ? filters.cost : null;
  const inputList = filters.input.length > 0 ? filters.input : null;
  const outputList = filters.output.length > 0 ? filters.output : null;
  const confidenceList = filters.confidence.length > 0 ? filters.confidence : null;

  const rows = await db.execute<DirectoryRow>(sql`
    with q as (
      select case when ${q}::text is null then null
                  else websearch_to_tsquery('english', ${q}::text) end as query
    )
    select t.id,
           t.slug,
           t.name,
           t.url,
           t.summary,
           t.cost_model,
           t.jurisdiction,
           t.confidence,
           t.reliability,
           t.last_verified_at,
           c.slug as category_slug,
           c.name as category_name,
           t.input_types,
           t.output_types,
           tg.tag_slugs,
           tg.tag_names,
           count(*) over () as total_count
    from ${tools} t
    join ${categories} c on c.id = t.category_id
    cross join q
    left join lateral (
      select array_agg(g.slug order by g.name) as tag_slugs,
             array_agg(g.name order by g.name) as tag_names
      from ${toolTags} tt
      join ${tags} g on g.id = tt.tag_id
      where tt.tool_id = t.id
    ) tg on true
    where t.status = ${"published"}
      and (q.query is null or t.search_vector @@ q.query)
      and (${category}::text is null or c.slug = ${category}::text)
      and (${sql.param(costList)}::text[] is null or t.cost_model = any(${sql.param(costList)}::text[]))
      and (${sql.param(confidenceList)}::text[] is null or t.confidence = any(${sql.param(confidenceList)}::text[]))
      and (${sql.param(inputList)}::text[] is null or t.input_types @> ${sql.param(inputList)}::text[])
      and (${sql.param(outputList)}::text[] is null or t.output_types @> ${sql.param(outputList)}::text[])
      and (${sql.param(tagList)}::text[] is null or tg.tag_slugs @> ${sql.param(tagList)}::text[])
    order by
      -- Relevance first when a query is present. ts_rank_cd(..., 32) is cover-density
      -- ranking normalised to (0,1) - search.md 6.1. Every branch ends in name asc, so
      -- ordering is total and a row cannot swap between pages under pagination.
      case when ${filters.sort}::text = 'relevance' and q.query is not null
           then ts_rank_cd(t.search_vector, q.query, 32) end desc nulls last,
      case when ${filters.sort}::text = 'recent' then t.published_at end desc nulls last,
      case when ${filters.sort}::text = 'reliability' then t.reliability end desc nulls last,
      t.name asc
    limit ${DIRECTORY_PAGE_SIZE} offset ${offset}
  `);

  const items = rows.rows.map(toCard);
  const total = rows.rows[0] ? Number(rows.rows[0].total_count) : 0;

  return {
    items,
    total,
    page: filters.page,
    pageSize: DIRECTORY_PAGE_SIZE,
    pageCount: Math.max(Math.ceil(total / DIRECTORY_PAGE_SIZE), 1),
  };
}

/**
 * Cached on the NORMALISED filter tuple (caching.md §6), never on the raw query string:
 * `?tag=b&tag=a` and `?tag=a&tag=b&junk=1` are one cache entry, and a crafted URL cannot
 * mint a new one.
 *
 * `directoryCacheKey` is passed as the cache argument rather than being interpolated into
 * `keyParts`, which stays constant.
 */
export async function listTools(filters: DirectoryFilters): Promise<ToolListPage> {
  const key = directoryCacheKey(filters);
  return cached(
    async (_key: string) => listToolsUncached(filters),
    ["tools-list"],
    { tags: [TAG.tools, TAG.categories, TAG.tags], revalidate: TTL.hour },
  )(key);
}

/* ------------------------------------------------------------------ *
 * Detail
 * ------------------------------------------------------------------ */

export type ToolDetail = {
  id: string;
  slug: string;
  name: string;
  url: string;
  summary: string;
  description: string;
  costModel: CostModel;
  costNotes: string | null;
  jurisdiction: string | null;
  legalNotes: string | null;
  confidence: ConfidenceLevel;
  reliability: number | null;
  reliabilityNotes: string | null;
  lastVerifiedAt: Date | null;
  publishedAt: Date | null;
  inputTypes: string[];
  outputTypes: string[];
  category: { slug: string; name: string };
  tags: { slug: string; name: string }[];
  /** Published playbooks that cite this tool, and the step that cites it. */
  usedInPlaybooks: { slug: string; title: string; stepTitle: string; note: string | null }[];
};

/**
 * `/tools/[slug]`. Returns null for a draft or a missing slug — the route turns that into a
 * 404 (HANDOFF §7, §11 assertion 3).
 *
 * TWO round trips: the tool with its category and tags, then the playbooks citing it.
 * They are deliberately not merged: the second is a three-table join whose result is a
 * different cardinality, and folding it into the first as another LATERAL aggregate would
 * cost more to read than the round trip saves on a page that is cached for an hour.
 */
async function getToolBySlugUncached(slug: string): Promise<ToolDetail | null> {
  const row = await db.query.tools.findFirst({
    where: and(eq(tools.slug, slug), eq(tools.status, "published")),
    with: {
      category: { columns: { slug: true, name: true } },
      toolTags: { with: { tag: { columns: { slug: true, name: true } } } },
    },
  });

  if (!row) return null;

  const citations = await db
    .select({
      slug: playbooks.slug,
      title: playbooks.title,
      stepTitle: playbookSteps.title,
      note: playbookStepTools.note,
      orderIndex: playbookSteps.orderIndex,
    })
    .from(playbookStepTools)
    .innerJoin(playbookSteps, eq(playbookSteps.id, playbookStepTools.stepId))
    .innerJoin(playbooks, eq(playbooks.id, playbookSteps.playbookId))
    .where(and(eq(playbookStepTools.toolId, row.id), eq(playbooks.status, "published")))
    .orderBy(asc(playbooks.title), asc(playbookSteps.orderIndex));

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    summary: row.summary,
    description: row.description,
    costModel: row.costModel,
    costNotes: row.costNotes,
    jurisdiction: row.jurisdiction,
    legalNotes: row.legalNotes,
    confidence: row.confidence,
    reliability: row.reliability,
    reliabilityNotes: row.reliabilityNotes,
    lastVerifiedAt: row.lastVerifiedAt,
    publishedAt: row.publishedAt,
    inputTypes: row.inputTypes,
    outputTypes: row.outputTypes,
    category: row.category,
    tags: row.toolTags.map((tt) => tt.tag).sort((a, b) => a.name.localeCompare(b.name)),
    usedInPlaybooks: citations.map(({ slug: s, title, stepTitle, note }) => ({
      slug: s,
      title,
      stepTitle,
      note,
    })),
  };
}

export const getToolBySlug = cachedByKey(
  getToolBySlugUncached,
  ["tool-by-slug"],
  (slug) => [TAG.tools, TAG.tool(slug)],
  TTL.hour,
);

/* ------------------------------------------------------------------ *
 * Listings that are not the directory
 * ------------------------------------------------------------------ */

/** Published tools carrying a tag, for `/tags/[slug]`. ONE round trip. */
async function listToolsByTagUncached(tagSlug: string): Promise<ToolCard[]> {
  const page = await listToolsUncached({
    q: "",
    category: undefined,
    tags: [tagSlug],
    cost: [],
    input: [],
    output: [],
    confidence: [],
    sort: "name",
    page: 1,
  });
  return page.items;
}

export const listToolsByTag = cachedByKey(
  listToolsByTagUncached,
  ["tools-by-tag"],
  (slug) => [TAG.tools, TAG.tags, TAG.tag(slug)],
  TTL.hour,
);

/**
 * The home page shelf: most recently published entries. `published_at DESC` is served by
 * `tools_status_published_at_idx`.
 */
async function listRecentToolsUncached(limit: number): Promise<ToolCard[]> {
  const page = await listToolsUncached({
    q: "",
    category: undefined,
    tags: [],
    cost: [],
    input: [],
    output: [],
    confidence: [],
    sort: "recent",
    page: 1,
  });
  return page.items.slice(0, limit);
}

export const listRecentTools = cached(listRecentToolsUncached, ["tools-recent"], {
  tags: [TAG.tools],
  revalidate: TTL.hour,
});

/** Published tool slugs, for `generateStaticParams` on `/tools/[slug]` and the sitemap. */
export async function listPublishedToolSlugs(): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: tools.slug, updatedAt: tools.updatedAt })
    .from(tools)
    .where(eq(tools.status, "published"))
    .orderBy(desc(tools.updatedAt));
}
