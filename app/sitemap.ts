import type { MetadataRoute } from "next";

import { logger } from "@/lib/logger";
import { absoluteUrl } from "@/lib/metadata";
import { listCategorySlugs, listTagSlugs } from "@/lib/queries/taxonomy";
import { listPublishedToolSlugs } from "@/lib/queries/tools";
import { TOOLBENCH_ENTRIES } from "@/lib/toolbench/registry";

/**
 * `sitemap.xml`, revalidated hourly. Only public, indexable routes. Excluded: `/search`,
 * `/signin*`, `/workspaces`, `/admin`, `/api`, and `/legal/*` (drafts, `noindex` for now).
 *
 * If the database is unreachable, returns the static routes and logs a warning rather than
 * a 500.
 */
export const revalidate = 3600;

/** Routes that exist regardless of what is in the database. */
function staticRoutes(now: Date): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: absoluteUrl("/directory"), lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: absoluteUrl("/playbooks"), lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/live"), lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: absoluteUrl("/live/flights"), lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: absoluteUrl("/live/cameras"), lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: absoluteUrl("/toolbench"), lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: absoluteUrl("/methodology"), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/about"), changeFrequency: "monthly", priority: 0.5 },

    // Toolbench routes from the static registry (registry.test.ts keeps it in sync with routes).
    ...TOOLBENCH_ENTRIES.map((entry) => ({
      url: absoluteUrl(`/toolbench/${entry.slug}`),
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries = staticRoutes(now);

  try {
    // Sequential to avoid hogging the small connection pool (and for the single-connection
    // dev harness).
    const tools = await listPublishedToolSlugs();
    const categories = await listCategorySlugs();
    const tags = await listTagSlugs();

    for (const tool of tools) {
      entries.push({
        url: absoluteUrl(`/tools/${tool.slug}`),
        lastModified: tool.updatedAt,
        changeFrequency: "monthly",
        priority: 0.7,
      });
    }

    for (const slug of categories) {
      entries.push({
        url: absoluteUrl(`/directory/${slug}`),
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }

    for (const slug of tags) {
      entries.push({
        url: absoluteUrl(`/tags/${slug}`),
        changeFrequency: "weekly",
        priority: 0.4,
      });
    }

    /*
     * TODO: add `/playbooks/[slug]` and `/live/cameras/[slug]` once published-slug queries
     * exist. They must return published rows only, or the sitemap leaks drafts.
     */
  } catch (error) {
    logger.warn(
      { err: error, scope: "sitemap" },
      "Sitemap fell back to static routes: catalogue query failed",
    );
  }

  return entries;
}
