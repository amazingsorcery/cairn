import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyCollection } from "@/components/directory/empty-results";
import { ToolCard, ToolGrid } from "@/components/directory/tool-card";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DIRECTORY_PAGE_SIZE, listToolsByTag } from "@/lib/queries/tools";
import { getTagBySlug, listTagSlugs } from "@/lib/queries/taxonomy";
import { pageMetadata } from "@/lib/metadata";

/**
 * `/tags/[slug]` — every published entry carrying one tag.
 *
 * **ISR:3600** (architecture HANDOFF §8). No `searchParams`, no `cookies()`, no `auth()`, so
 * the `revalidate` below actually means something. Refinement is a link into `/directory`,
 * which is the one route that owns query state.
 *
 * `generateStaticParams` uses `listTagSlugs()`, which returns only tags with at least one
 * **published** tool. That is not an optimisation: prerendering a slug that only draft rows
 * carry would publicly confirm that an unpublished entry exists. `dynamicParams` stays at its
 * default, so a tag that gains its first published tool is reachable without a redeploy.
 */

export const revalidate = 3600;

interface TagPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const slugs = await listTagSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: TagPageProps) {
  const { slug } = await params;
  const tag = await getTagBySlug(slug);
  if (!tag) {
    return pageMetadata({ title: "Not found", description: "", path: `/tags/${slug}`, index: false });
  }

  return pageMetadata({
    title: tag.name,
    description:
      tag.description ??
      `Open-source intelligence tools and data sources tagged ${tag.name}, each with its cost, jurisdiction, and the date a human last checked it.`,
    path: `/tags/${tag.slug}`,
  });
}

export default async function TagPage({ params }: TagPageProps) {
  const { slug } = await params;
  const tag = await getTagBySlug(slug);
  if (!tag) notFound();

  const tools = await listToolsByTag(tag.slug);
  const refineHref = `/directory?tag=${encodeURIComponent(tag.slug)}`;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[{ label: "directory", href: "/directory" }, { label: `tag: ${tag.name}` }]}
      />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">{tag.name}</h1>
      <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">
        {tag.description ?? `Published entries carrying the ${tag.name} tag.`}
      </p>

      {tools.length > 0 ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="tabular text-xs text-muted-foreground">
              {tools.length === 1 ? "1 tool" : `${tools.length} tools`} · sorted by name
            </p>
            <Button asChild variant="outline">
              <Link href={refineHref}>filter and sort these</Link>
            </Button>
          </div>

          <div className="mt-4">
            <ToolGrid>
              {tools.map((tool) => (
                <li key={tool.id} className="h-full">
                  <ToolCard tool={tool} />
                </li>
              ))}
            </ToolGrid>
          </div>

          {/*
            `listToolsByTag` returns the first page of the shared directory query, so a tag
            carried by more entries than fit on one page is truncated here. Saying so is
            cheaper than a silent cut, and the link goes where the rest actually are.
          */}
          {tools.length === DIRECTORY_PAGE_SIZE ? (
            <p className="mt-8 text-sm text-foreground-secondary">
              Showing the first {DIRECTORY_PAGE_SIZE} by name.{" "}
              <Link
                href={refineHref}
                className="font-medium text-primary underline underline-offset-4"
              >
                Open this tag in the directory
              </Link>{" "}
              to page through the rest.
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-8">
          <EmptyCollection name={tag.name} kind="tag" />
        </div>
      )}
    </div>
  );
}
