import type { MetadataRoute } from "next";

import { logger } from "@/lib/logger";
import { absoluteUrl } from "@/lib/metadata";
import { listCategorySlugs, listTagSlugs } from "@/lib/queries/taxonomy";
import { listPublishedToolSlugs } from "@/lib/queries/tools";

/**
 * `sitemap.xml`. ISR:3600, matching the caching contract in architecture HANDOFF §8.
 *
 * Only publicly readable, indexable routes appear. Deliberately absent:
 *
 *   - `/search` — no content of its own; every useful URL under it is a query string.
 *   - `/signin`, `/signin/*` — a sign-in form is not a search result.
 *   - `/workspaces/**`, `/admin/**`, `/api/**` — disallowed in `app/robots.ts` and
 *     `noindex` at the edge.
 *   - `/legal/*` — the policies are pre-launch drafts and their pages carry `noindex`
 *     until counsel signs them off. Listing a draft policy in a sitemap invites a crawler
 *     to treat it as settled, which is the opposite of what the draft banner says.
 *
 * DEGRADATION. The catalogue entries come from the database. If it is unreachable this
 * returns the static routes and logs, rather than throwing: a sitemap missing its detail
 * URLs for one revalidation window costs a little crawl freshness, while a 500 on
 * `/sitemap.xml` is what actually gets a site dropped. The failure is logged at `warn` so
 * it is visible rather than silent.
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
    { url: absoluteUrl("/methodology"), changeFrequency: "monthly", priority: 0.8 },
    { url: absoluteUrl("/about"), changeFrequency: "monthly", priority: 0.5 },
  ];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries = staticRoutes(now);

  try {
    // Sequential, not `Promise.all`. This route regenerates in the background once an hour
    // and competes with live requests for a pool of ten connections on a 2 GB box; taking
    // one at a time costs a few milliseconds nobody is waiting for. It is also what makes
    // the route work against the single-connection local dev harness.
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
     * INTEGRATION POINT — playbooks and cameras.
     *
     * `/playbooks/[slug]` and `/live/cameras/[slug]` are public, indexable detail routes and
     * belong here. `lib/queries/` has no published-slug export for either yet: there is no
     * `lib/queries/playbooks.ts` and no `lib/queries/cameras.ts` at the time this file was
     * written, and importing a function that does not exist is worse than omitting the URLs.
     *
     * When the backend adds them, mirror the `tools` block above:
     *
     *   for (const playbook of await listPublishedPlaybookSlugs()) {
     *     entries.push({ url: absoluteUrl(`/playbooks/${playbook.slug}`), … });
     *   }
     *
     * Whatever those exports are called, they must return **published rows only**. A draft
     * slug in the sitemap is a public confirmation that an unpublished entry exists, which is
     * exactly what the 404 behaviour in `docs/design/states.md` §1.2 exists to prevent.
     */
  } catch (error) {
    logger.warn(
      { err: error, scope: "sitemap" },
      "Sitemap fell back to static routes: catalogue query failed",
    );
  }

  return entries;
}
