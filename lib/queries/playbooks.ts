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
 * Playbook reads; public reads filter `status = 'published'`. `/playbooks` filters
 * client-side over a prerendered list (there are few playbooks).
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

/** Published listing in one query. Only step ids are selected for the step count. */
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
 * `/playbooks/[slug]`, or null for a draft or missing slug. Playbook, steps and linked tools
 * in one query (avoids N+1). Linked tools are fetched with `status` and unpublished ones are
 * dropped in the mapping below.
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

/** Also tagged `tools`, since the page renders linked tools' names and summaries. */
export const getPlaybookBySlug = cachedByKey(
  getPlaybookBySlugUncached,
  ["playbook-by-slug"],
  (slug) => [TAG.playbooks, TAG.playbook(slug), TAG.tools],
  TTL.hour,
);

/** Steps of a published playbook, in order, for deriving a workspace checklist. Uncached. */
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
