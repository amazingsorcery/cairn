import { sql } from "drizzle-orm";

import { categories, playbookSteps, playbooks, tags, toolTags, tools } from "@/db/schema";
import type { Db } from "@/lib/db";

/**
 * The `search_keywords` fan-out. The generated `search_vector` column can only use immutable
 * same-row expressions, so the write path flattens category, tag names and facet arrays into
 * `search_keywords` for it to read.
 *
 * Callers pass the transaction of the triggering write; otherwise search silently drifts.
 * Raw SQL for set-based `UPDATE ... FROM`; only uuid arrays are bound.
 */

/**
 * Recompute `search_keywords` for the named tools: category, tags (by name), `input_types`,
 * `output_types`. Ordered so the value is deterministic and unchanged rows don't churn the
 * index. No-op on an empty list.
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
    where c.id = t.category_id and t.id = any(${sql.param(toolIds)}::uuid[])
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
    where c.id = p.category_id and p.id = any(${sql.param(playbookIds)}::uuid[])
  `);
}

/** Every tool carrying one of these tags. Used when a tag is renamed. */
export async function toolIdsForTags(client: Db, tagIds: readonly string[]): Promise<string[]> {
  if (tagIds.length === 0) return [];
  const rows = await client.execute<{ tool_id: string }>(sql`
    select distinct tool_id from ${toolTags} where tag_id = any(${sql.param(tagIds)}::uuid[])
  `);
  return rows.rows.map((r) => r.tool_id);
}

/** Every tool in these categories. Used when a category is renamed. */
export async function toolIdsForCategories(
  client: Db,
  categoryIds: readonly string[],
): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const rows = await client.execute<{ id: string }>(sql`
    select id from ${tools} where category_id = any(${sql.param(categoryIds)}::uuid[])
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
    select id from ${playbooks} where category_id = any(${sql.param(categoryIds)}::uuid[])
  `);
  return rows.rows.map((r) => r.id);
}

/**
 * Slugs of playbooks citing these tools, for cache purging. Call before deleting: the
 * cascade removes the `playbook_step_tools` rows.
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
    where pst.tool_id = any(${sql.param(toolIds)}::uuid[])
  `);
  return rows.rows.map((r) => r.slug);
}

/** The tag slugs a tool carries, for the per-tag cache purge. */
export async function tagSlugsForTool(client: Db, toolId: string): Promise<string[]> {
  const rows = await client.execute<{ slug: string }>(sql`
    select g.slug from ${toolTags} tt join ${tags} g on g.id = tt.tag_id
    where tt.tool_id = ${toolId}
    order by g.slug
  `);
  return rows.rows.map((r) => r.slug);
}
