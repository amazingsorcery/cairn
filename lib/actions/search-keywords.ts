import { sql } from "drizzle-orm";

import { categories, playbookSteps, playbooks, tags, toolTags, tools } from "@/db/schema";
import type { Db } from "@/lib/db";

/**
 * The `search_keywords` fan-out. `docs/architecture/HANDOFF.md` §4 and `search.md` §3.
 *
 * WHY THIS EXISTS. `tools.search_vector` is a `tsvector GENERATED ALWAYS … STORED` column,
 * and a generated column's expression must be IMMUTABLE and may only reference columns of
 * the same row. Neither restriction can be worked around for the facets: tags live in
 * another table, and `array_to_string(anyarray, text)` is STABLE rather than IMMUTABLE. So
 * the write path flattens category name, tag names and the two facet arrays into the plain
 * `search_keywords` text column, and the generated column reads that.
 *
 * WHY IT MUST BE IN THE SAME TRANSACTION AS THE WRITE THAT TRIGGERS IT. Getting this wrong
 * degrades search silently, which is the worst failure mode available: the row is in the
 * catalogue, the page renders, the entry is simply unfindable by the facet that should find
 * it. Nothing errors. Nobody notices until a reader reports that searching for a tag name
 * returns nothing.
 *
 * Every function here therefore takes a `Db`, which is either the pool client or an open
 * transaction, and every caller passes the transaction it is already inside.
 *
 * Raw SQL through the `sql` tag: these are set-based `UPDATE … FROM` statements that touch
 * every affected row in one round trip, which Drizzle's builder cannot express. The only
 * interpolated values are bound parameter arrays of uuids.
 */

/**
 * Recompute `search_keywords` for the named tools.
 *
 * Derivation, exactly as HANDOFF §4 specifies: category name, then tag names ordered by
 * name, then `input_types`, then `output_types`, single-space joined and trimmed. The
 * ordering is what makes the value deterministic — an unordered `string_agg` would rewrite
 * the column (and therefore the tsvector, and therefore the GIN index) on every save even
 * when nothing changed.
 *
 * A no-op on an empty list rather than an `UPDATE … WHERE id = ANY('{}')`, so callers do not
 * have to remember to guard.
 */
export async function recomputeToolSearchKeywords(
  client: Db,
  toolIds: readonly string[],
): Promise<void> {
  if (toolIds.length === 0) return;

  await client.execute(sql`
    update ${tools} t set search_keywords = trim(both ' ' from (
        coalesce(c.name, '') || ' ' ||
        coalesce((select string_agg(g.name, ' ' order by g.name)
                  from ${toolTags} tt join ${tags} g on g.id = tt.tag_id
                  where tt.tool_id = t.id), '') || ' ' ||
        array_to_string(t.input_types,  ' ') || ' ' ||
        array_to_string(t.output_types, ' ')
    ))
    from ${categories} c
    where c.id = t.category_id and t.id = any(${[...toolIds]}::uuid[])
  `);
}

/**
 * Recompute `search_keywords` for the named playbooks: category name plus every step title
 * and objective, ordered by `order_index`.
 */
export async function recomputePlaybookSearchKeywords(
  client: Db,
  playbookIds: readonly string[],
): Promise<void> {
  if (playbookIds.length === 0) return;

  await client.execute(sql`
    update ${playbooks} p set search_keywords = trim(both ' ' from (
        coalesce(c.name, '') || ' ' ||
        coalesce((select string_agg(s.title || ' ' || s.objective, ' ' order by s.order_index)
                  from ${playbookSteps} s where s.playbook_id = p.id), '')
    ))
    from ${categories} c
    where c.id = p.category_id and p.id = any(${[...playbookIds]}::uuid[])
  `);
}

/**
 * Every tool carrying one of these tags. Used when a TAG IS RENAMED: the rename changes the
 * text that belongs in `search_keywords` on every tool that carries it, and HANDOFF §11
 * assertion 6 requires the tool to be findable by the new tag name afterwards.
 */
export async function toolIdsForTags(client: Db, tagIds: readonly string[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const rows = await client.execute<{ tool_id: string }>(sql`
    select distinct tool_id from ${toolTags} where tag_id = any(${[...tagIds]}::uuid[])
  `);
  return rows.rows.map((r) => r.tool_id);
}

/** Every tool in these categories. Used when a CATEGORY IS RENAMED. */
export async function toolIdsForCategories(
  client: Db,
  categoryIds: readonly string[],
): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const rows = await client.execute<{ id: string }>(sql`
    select id from ${tools} where category_id = any(${[...categoryIds]}::uuid[])
  `);
  return rows.rows.map((r) => r.id);
}

/** Every playbook in these categories. A category rename fans out to both tables. */
export async function playbookIdsForCategories(
  client: Db,
  categoryIds: readonly string[],
): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const rows = await client.execute<{ id: string }>(sql`
    select id from ${playbooks} where category_id = any(${[...categoryIds]}::uuid[])
  `);
  return rows.rows.map((r) => r.id);
}

/**
 * The playbooks that cite these tools, resolved BEFORE a delete cascades.
 *
 * HANDOFF §7 and caching.md §5.2: deleting a tool removes the `playbook_step_tools` rows by
 * cascade, so the slugs of the playbooks whose cached pages contain that tool's name must be
 * collected first. Afterwards there is nothing left to join.
 */
export async function playbookSlugsCitingTools(
  client: Db,
  toolIds: readonly string[],
): Promise<string[]> {
  if (toolIds.length === 0) return [];
  const rows = await client.execute<{ slug: string }>(sql`
    select distinct p.slug
    from playbook_step_tools pst
    join ${playbookSteps} s on s.id = pst.step_id
    join ${playbooks} p on p.id = s.playbook_id
    where pst.tool_id = any(${[...toolIds]}::uuid[])
  `);
  return rows.rows.map((r) => r.slug);
}

/** The tag slugs a tool carries, for the per-tag cache purge (caching.md §5). */
export async function tagSlugsForTool(client: Db, toolId: string): Promise<string[]> {
  const rows = await client.execute<{ slug: string }>(sql`
    select g.slug from ${toolTags} tt join ${tags} g on g.id = tt.tag_id
    where tt.tool_id = ${toolId}
    order by g.slug
  `);
  return rows.rows.map((r) => r.slug);
}
