import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyCollection } from "@/components/directory/empty-results";
import { ToolCard, ToolGrid } from "@/components/directory/tool-card";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DIRECTORY_PAGE_SIZE, listToolsByTag } from "@/lib/queries/tools";
import { getTagBySlug, listTagSlugs } from "@/lib/queries/taxonomy";
import { pageMetadata } from "@/lib/metadata";
import { staticParamsOrEmpty } from "@/lib/static-params";

/**
 * `/tags/[slug]`: published tools with one tag. ISR (1h); don't read `searchParams`,
 * `cookies()` or `auth()`. Filtering links to `/directory`.
 *
 * Static params only include tags with a published tool, so drafts aren't revealed.
 * `dynamicParams` is left on so newly used tags work without a redeploy.
 */

export const revalidate = 3600;

interface TagPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  // Tolerates a build with no database.
  return staticParamsOrEmpty("/tags/[slug]", async () => {
    const slugs = await listTagSlugs();
    return slugs.map((slug) => ({ slug }));
  });
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

          {/* `listToolsByTag` returns one page only, so flag truncation and link to the rest. */}
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
