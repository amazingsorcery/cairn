import { sql } from "drizzle-orm";

import { categories, tags, toolTags, tools } from "@/db/schema";
import { db } from "@/lib/db";
import { directoryCacheKey, type DirectoryFilters } from "@/lib/validation/filters";
import { TAG, TTL, cached } from "./cache";

/**
 * Facet counts for `/directory`.
 *
 * In its own module rather than in `tools.ts` because it is a different kind of read: one
 * statement whose whole job is arithmetic about the filter rail, with no row projection and
 * no pagination. Keeping it separate also keeps the fact that it is INDEPENDENTLY FAILABLE
 * visible at the import site — `states.md` §2.5 renders the facet list without counts, so a
 * caller composes this with `listTools` via `Promise.allSettled`.
 */

export type FacetCount = { value: string; count: number };

/**
 * How many published tools each facet value would yield under the filters currently applied.
 *
 * Every list is sorted by descending count, then by value — so the most useful option is
 * first and the order is deterministic between requests. A facet rail that reshuffles on
 * every render is unusable.
 */
export type DirectoryFacetCounts = {
  cost: FacetCount[];
  confidence: FacetCount[];
  input: FacetCount[];
  output: FacetCount[];
  category: FacetCount[];
  tag: FacetCount[];
};

/** The all-empty shape, for a caller rendering `states.md` §2.5 after a rejection. */
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
 * ── THE RULE THAT MAKES THE NUMBERS BEHAVE ──────────────────────────────────
 * **Each facet is excluded from its own count.** Counting `cost` applies the query, the
 * category, the tags, the confidence and both type filters — but NOT the cost filter.
 *
 * Without that, selecting `cost=free` would show `free 56` and every other cost model at
 * `0`, because the only rows left in the set are free ones. A reader would conclude nothing
 * else exists, when what the number should tell them is "switching to freemium gives you
 * 27". Counts exist to answer *"what happens if I change this one thing"*, and that question
 * is only answerable if the facet is held out of its own arithmetic.
 *
 * Within a facet values are OR-ed and across facets they are AND-ed — exactly what the
 * `= any(…)` and `@> …` predicates in `listTools` already do — so each facet's count is
 * computed against precisely the set that facet is choosing from.
 *
 * ── COST: ONE ROUND TRIP ────────────────────────────────────────────────────
 * One statement. A CTE evaluates each filter predicate ONCE per row as a boolean column, and
 * six `UNION ALL` branches aggregate with all the *other* predicates applied. The obvious
 * alternative — one query per facet, each re-running the whole predicate set — is six round
 * trips and six copies of the same filter logic, which is where the copies drift apart.
 *
 * `input_types`, `output_types` and the aggregated tag slugs are arrays, so those branches
 * `unnest` and count per unnested value. That is the right unit: a tool with three input
 * types contributes one to each of three counts.
 *
 * Raw SQL through the `sql` tag, because neither the boolean-flag CTE, nor `unnest`, nor the
 * `UNION ALL` shape has a builder equivalent. Every value below is a bound parameter.
 */
async function getDirectoryFacetCountsUncached(
  filters: DirectoryFilters,
): Promise<DirectoryFacetCounts> {
  // The same NULL-for-empty convention as `listToolsUncached`, so the counts and the results
  // agree by construction rather than by coincidence.
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
    // `count(*)` is a bigint, which node-postgres hands over as a string rather than
    // silently losing precision past 2^53.
    bucket[row.facet]?.push({ value: row.value, count: Number(row.n) });
  }

  for (const list of Object.values(bucket)) {
    list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  return out;
}

/**
 * Cached on the same normalised filter tuple and under the same tags as `listTools`, so the
 * results and their counts are invalidated together and cannot disagree.
 *
 * `states.md` §2.5 permits rendering the facet list WITHOUT counts, so treat this as
 * independently failable: `Promise.allSettled` alongside `listTools`, and on rejection render
 * the checkboxes bare with "Result counts are unavailable right now. The filters still work."
 * Counts are an affordance; results are the page.
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
