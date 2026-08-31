import { asc, eq, sql } from "drizzle-orm";

import { categories, playbooks, tags, toolTags, tools } from "@/db/schema";
import { db } from "@/lib/db";
import { TAG, TTL, cached, cachedByKey } from "./cache";

/**
 * Categories and tags. Both are small, both are read on nearly every public page, and both
 * are cached hard — the nav and the facet rail are the same rows on every request.
 */

export type CategorySummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  /** Published tools in this category. Drives the facet count and hides empty categories. */
  toolCount: number;
  playbookCount: number;
};

/**
 * Every category with its published counts.
 *
 * ONE round trip. The counts are correlated subqueries rather than a `LEFT JOIN … GROUP BY`
 * because two independent joins onto one parent would multiply rows against each other and
 * need `count(DISTINCT …)` to undo it. Raw SQL through the `sql` tag: Drizzle can express
 * this, but only as two queries or one with a lateral join, and the correlated form is the
 * one that reads as what it is. No user input is interpolated — the only literal is the
 * status value, and it is bound.
 */
async function listCategoriesUncached(): Promise<CategorySummary[]> {
  const rows = await db.execute<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    sort_order: number;
    tool_count: string;
    playbook_count: string;
  }>(sql`
    select c.id,
           c.slug,
           c.name,
           c.description,
           c.sort_order,
           (select count(*) from ${tools} t
             where t.category_id = c.id and t.status = ${"published"}) as tool_count,
           (select count(*) from ${playbooks} p
             where p.category_id = c.id and p.status = ${"published"}) as playbook_count
    from ${categories} c
    order by c.sort_order asc, c.name asc
  `);

  return rows.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    // `count(*)` comes back as a bigint, which node-postgres hands over as a string to
    // avoid silently losing precision past 2^53. Parse rather than trusting the shape.
    toolCount: Number(row.tool_count),
    playbookCount: Number(row.playbook_count),
  }));
}

export const listCategories = cached(listCategoriesUncached, ["categories-list"], {
  tags: [TAG.categories, TAG.tools, TAG.playbooks],
  revalidate: TTL.hour,
});

/** One category by slug, or null. Used by `/directory/[category]`. */
async function getCategoryBySlugUncached(slug: string) {
  const row = await db.query.categories.findFirst({ where: eq(categories.slug, slug) });
  return row ?? null;
}

export const getCategoryBySlug = cachedByKey(
  getCategoryBySlugUncached,
  ["category-by-slug"],
  (slug) => [TAG.categories, TAG.category(slug)],
  TTL.hour,
);

export type TagSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  toolCount: number;
};

/**
 * Tags that carry at least one PUBLISHED tool, with their counts.
 *
 * ONE round trip, one `GROUP BY`. Tags with no published tools are excluded by the inner
 * join rather than filtered afterwards: a facet chip that returns an empty page is worse
 * than no chip.
 */
async function listTagsUncached(): Promise<TagSummary[]> {
  const rows = await db
    .select({
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
      description: tags.description,
      toolCount: sql<number>`count(${tools.id})::int`,
    })
    .from(tags)
    .innerJoin(toolTags, eq(toolTags.tagId, tags.id))
    .innerJoin(tools, eq(tools.id, toolTags.toolId))
    .where(eq(tools.status, "published"))
    .groupBy(tags.id, tags.slug, tags.name, tags.description)
    .orderBy(asc(tags.name));

  return rows;
}

export const listTags = cached(listTagsUncached, ["tags-list"], {
  tags: [TAG.tags, TAG.tools],
  revalidate: TTL.hour,
});

async function getTagBySlugUncached(slug: string) {
  const row = await db.query.tags.findFirst({ where: eq(tags.slug, slug) });
  return row ?? null;
}

export const getTagBySlug = cachedByKey(
  getTagBySlugUncached,
  ["tag-by-slug"],
  (slug) => [TAG.tags, TAG.tag(slug)],
  TTL.hour,
);

/**
 * Every category slug, for `generateStaticParams` on `/directory/[category]`.
 * All of them, not only the non-empty ones — a category page with no tools yet is a valid
 * page, and `dynamicParams` stays at its default so a new one is reachable without a
 * redeploy anyway.
 */
export async function listCategorySlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: categories.slug })
    .from(categories)
    .orderBy(asc(categories.slug));
  return rows.map((r) => r.slug);
}

/** Tag slugs that have at least one published tool, for `generateStaticParams`. */
export async function listTagSlugs(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ slug: tags.slug })
    .from(tags)
    .innerJoin(toolTags, eq(toolTags.tagId, tags.id))
    .innerJoin(tools, eq(tools.id, toolTags.toolId))
    .where(eq(tools.status, "published"))
    .orderBy(asc(tags.slug));
  return rows.map((r) => r.slug);
}
