import { and, asc, desc, eq } from "drizzle-orm";

import {
  playbookSteps,
  playbooks,
  type ConfidenceLevel,
  type DifficultyLevel,
} from "@/db/schema";
import { db } from "@/lib/db";
import { TAG, TTL, cached, cachedByKey } from "./cache";

/**
 * Playbook reads. Public reads filter `status = 'published'` (HANDOFF §7).
 *
 * `/playbooks` is ISR with client-side filtering over a prerendered payload (sitemap.md §2)
 * — there are two orders of magnitude fewer playbooks than tools, so there is no
 * server-side filter surface and no `searchParams` to normalise.
 */

export type PlaybookCard = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  difficulty: DifficultyLevel;
  estimatedMinutes: number;
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
  categorySlug: string;
  categoryName: string;
  stepCount: number;
};

/**
 * The full published listing. ONE round trip: the step count is a relational aggregate
 * expressed as a nested `with`, and Drizzle's relational API compiles the whole thing into
 * a single statement with a lateral json aggregation.
 *
 * Only step ids are selected for the count — pulling every step's Markdown body to call
 * `.length` on the array would move the entire corpus over the wire to produce an integer.
 */
async function listPlaybooksUncached(): Promise<PlaybookCard[]> {
  const rows = await db.query.playbooks.findMany({
    where: eq(playbooks.status, "published"),
    orderBy: [asc(playbooks.title)],
    columns: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      difficulty: true,
      estimatedMinutes: true,
      confidence: true,
      lastVerifiedAt: true,
    },
    with: {
      category: { columns: { slug: true, name: true } },
      steps: { columns: { id: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    difficulty: row.difficulty,
    estimatedMinutes: row.estimatedMinutes,
    confidence: row.confidence,
    lastVerifiedAt: row.lastVerifiedAt,
    categorySlug: row.category.slug,
    categoryName: row.category.name,
    stepCount: row.steps.length,
  }));
}

export const listPlaybooks = cached(listPlaybooksUncached, ["playbooks-list"], {
  tags: [TAG.playbooks, TAG.categories],
  revalidate: TTL.halfHour,
});

export type PlaybookStepDetail = {
  id: string;
  orderIndex: number;
  title: string;
  objective: string;
  body: string;
  doneWhen: string;
  tools: {
    slug: string;
    name: string;
    summary: string;
    confidence: ConfidenceLevel;
    lastVerifiedAt: Date | null;
    note: string | null;
  }[];
};

export type PlaybookDetail = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  overview: string | null;
  difficulty: DifficultyLevel;
  estimatedMinutes: number;
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
  publishedAt: Date | null;
  category: { slug: string; name: string };
  steps: PlaybookStepDetail[];
};

/**
 * `/playbooks/[slug]`. Returns null for a draft or a missing slug; the route 404s
 * (HANDOFF §11 assertion 3).
 *
 * ONE round trip. The nested `with` — playbook, steps, each step's tool links, each link's
 * tool — is a single statement. The naive version of this page is the textbook N+1: one
 * query for the playbook, one per step for its tools, one per tool for its row.
 *
 * Tools linked from a step are NOT filtered to `published` here. A step that cites a tool
 * which has since been unpublished must still render the citation, because the method still
 * says to use it; the UI renders an unpublished citation as plain text without a link. The
 * alternative — silently dropping the tool — changes what the method says.
 */
async function getPlaybookBySlugUncached(slug: string): Promise<PlaybookDetail | null> {
  const row = await db.query.playbooks.findFirst({
    where: and(eq(playbooks.slug, slug), eq(playbooks.status, "published")),
    with: {
      category: { columns: { slug: true, name: true } },
      steps: {
        orderBy: [asc(playbookSteps.orderIndex)],
        with: {
          toolLinks: {
            with: {
              tool: {
                columns: {
                  slug: true,
                  name: true,
                  summary: true,
                  confidence: true,
                  lastVerifiedAt: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    overview: row.overview,
    difficulty: row.difficulty,
    estimatedMinutes: row.estimatedMinutes,
    confidence: row.confidence,
    lastVerifiedAt: row.lastVerifiedAt,
    publishedAt: row.publishedAt,
    category: row.category,
    steps: row.steps.map((step) => ({
      id: step.id,
      orderIndex: step.orderIndex,
      title: step.title,
      objective: step.objective,
      body: step.body,
      doneWhen: step.doneWhen,
      tools: [...step.toolLinks]
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .filter((link) => link.tool.status === "published")
        .map((link) => ({
          slug: link.tool.slug,
          name: link.tool.name,
          summary: link.tool.summary,
          confidence: link.tool.confidence,
          lastVerifiedAt: link.tool.lastVerifiedAt,
          note: link.note,
        })),
    })),
  };
}

/**
 * Carries the `tools` tag as well as its own, because the page renders the name and summary
 * of every tool linked from every step: republishing a tool must refresh the playbooks that
 * cite it (caching.md §4).
 */
export const getPlaybookBySlug = cachedByKey(
  getPlaybookBySlugUncached,
  ["playbook-by-slug"],
  (slug) => [TAG.playbooks, TAG.playbook(slug), TAG.tools],
  TTL.hour,
);

/**
 * The steps of a published playbook, in order, for deriving a workspace checklist. Not
 * cached: it is read once at workspace creation, inside the same transaction as the write.
 *
 * Published only. Starting a case from a draft playbook would expose unpublished editorial
 * work through a side door.
 */
export async function getPublishedPlaybookSteps(playbookId: string) {
  return db
    .select({
      id: playbookSteps.id,
      orderIndex: playbookSteps.orderIndex,
      title: playbookSteps.title,
    })
    .from(playbookSteps)
    .innerJoin(playbooks, eq(playbooks.id, playbookSteps.playbookId))
    .where(and(eq(playbookSteps.playbookId, playbookId), eq(playbooks.status, "published")))
    .orderBy(asc(playbookSteps.orderIndex));
}

/** Published playbook slugs, for `generateStaticParams` and the sitemap. */
export async function listPublishedPlaybookSlugs(): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: playbooks.slug, updatedAt: playbooks.updatedAt })
    .from(playbooks)
    .where(eq(playbooks.status, "published"))
    .orderBy(desc(playbooks.updatedAt));
}
