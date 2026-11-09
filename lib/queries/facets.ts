import { sql } from "drizzle-orm";

import { categories, tags, toolTags, tools } from "@/db/schema";
import { db } from "@/lib/db";
import { directoryCacheKey, type DirectoryFilters } from "@/lib/validation/filters";
import { TAG, TTL, cached } from "./cache";

/**
 * Facet counts for `/directory`. Separate from `tools.ts` because it can fail independently:
 * callers pair it with `listTools` via `Promise.allSettled` and render facets without counts.
 */

export type FacetCount = { value: string; count: number };

/**
 * Published-tool count per facet value under the current filters. Sorted by count desc, then
 * value, so the order is stable between requests.
 */
export type DirectoryFacetCounts = {
  cost: FacetCount[];
  confidence: FacetCount[];
  input: FacetCount[];
  output: FacetCount[];
  category: FacetCount[];
  tag: FacetCount[];
};

/** Empty counts, for rendering facets without counts after a failure. */
export const NO_FACET_COUNTS: DirectoryFacetCounts = Object.freeze({
  cost: [],
  confidence: [],
  input: [],
  output: [],
  category: [],
  tag: [],
});

type FacetRow = { facet: string; value: string; n: string };

/**
 * Each facet is excluded from its own count, so selecting `cost=free` still shows how many
 * results other cost models would give. Predicates match `listTools`.
 *
 * One query: a CTE computes each predicate once as a boolean, and one `UNION ALL` branch per
 * facet applies the others. Array columns are unnested and counted per value. Raw SQL since
 * the builder can't express this; all values are bound parameters.
 */
async function getDirectoryFacetCountsUncached(
  filters: DirectoryFilters,
): Promise<DirectoryFacetCounts> {
  // Same NULL-for-empty convention as `listToolsUncached`.
  const q = filters.q || null;
  const category = filters.category ?? null;
  const tagList = filters.tags.length > 0 ? filters.tags : null;
  const costList = filters.cost.length > 0 ? filters.cost : null;
  const inputList = filters.input.length > 0 ? filters.input : null;
  const outputList = filters.output.length > 0 ? filters.output : null;
  const confidenceList = filters.confidence.length > 0 ? filters.confidence : null;

  const rows = await db.execute<FacetRow>(sql`
    with base as (
      select t.id,
             t.cost_model,
             t.confidence,
             t.input_types,
             t.output_types,
             c.slug as category_slug,
             coalesce(tg.tag_slugs, '{}'::text[]) as tag_slugs,
             (${q}::text is null
               or t.search_vector @@ websearch_to_tsquery('english', ${q}::text)) as m_q,
             (${category}::text is null or c.slug = ${category}::text) as m_cat,
             (${sql.param(tagList)}::text[] is null
               or coalesce(tg.tag_slugs, '{}'::text[]) @> ${sql.param(tagList)}::text[]) as m_tag,
             (${sql.param(costList)}::text[] is null
               or t.cost_model = any(${sql.param(costList)}::text[])) as m_cost,
             (${sql.param(confidenceList)}::text[] is null
               or t.confidence = any(${sql.param(confidenceList)}::text[])) as m_conf,
             (${sql.param(inputList)}::text[] is null
               or t.input_types @> ${sql.param(inputList)}::text[]) as m_in,
             (${sql.param(outputList)}::text[] is null
               or t.output_types @> ${sql.param(outputList)}::text[]) as m_out
      from ${tools} t
      join ${categories} c on c.id = t.category_id
      left join lateral (
        select array_agg(g.slug order by g.slug) as tag_slugs
        from ${toolTags} tt join ${tags} g on g.id = tt.tag_id
        where tt.tool_id = t.id
      ) tg on true
      where t.status = ${"published"}
    )
    select 'cost' as facet, cost_model as value, count(*)::text as n from base
      where m_q and m_cat and m_tag and m_conf and m_in and m_out
      group by 1, 2
    union all
    select 'confidence', confidence, count(*)::text from base
      where m_q and m_cat and m_tag and m_cost and m_in and m_out
      group by 1, 2
    union all
    select 'category', category_slug, count(*)::text from base
      where m_q and m_tag and m_cost and m_conf and m_in and m_out
      group by 1, 2
    union all
    select 'input', v, count(*)::text from base, unnest(base.input_types) as v
      where m_q and m_cat and m_tag and m_cost and m_conf and m_out
      group by 1, 2
    union all
    select 'output', v, count(*)::text from base, unnest(base.output_types) as v
      where m_q and m_cat and m_tag and m_cost and m_conf and m_in
      group by 1, 2
    union all
    select 'tag', v, count(*)::text from base, unnest(base.tag_slugs) as v
      where m_q and m_cat and m_cost and m_conf and m_in and m_out
      group by 1, 2
  `);

  const out: DirectoryFacetCounts = {
    cost: [],
    confidence: [],
    input: [],
    output: [],
    category: [],
    tag: [],
  };

  const bucket: Record<string, FacetCount[]> = {
    cost: out.cost,
    confidence: out.confidence,
    category: out.category,
    input: out.input,
    output: out.output,
    tag: out.tag,
  };

  for (const row of rows.rows) {
    // node-postgres returns bigint `count(*)` as a string.
    bucket[row.facet]?.push({ value: row.value, count: Number(row.n) });
  }

  for (const list of Object.values(bucket)) {
    list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  return out;
}

/**
 * Cached with the same key and tags as `listTools` so counts and results invalidate together.
 * If this rejects, render the checkboxes without counts.
 */
export async function getDirectoryFacetCounts(
  filters: DirectoryFilters,
): Promise<DirectoryFacetCounts> {
  const key = directoryCacheKey(filters);
  return cached(
    async (_key: string) => getDirectoryFacetCountsUncached(filters),
    ["directory-facet-counts"],
    { tags: [TAG.tools, TAG.categories, TAG.tags], revalidate: TTL.hour },
  )(key);
}
