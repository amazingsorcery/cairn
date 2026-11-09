import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyCollection } from "@/components/directory/empty-results";
import { ToolCard, ToolGrid } from "@/components/directory/tool-card";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DIRECTORY_PAGE_SIZE, listTools } from "@/lib/queries/tools";
import { getCategoryBySlug, listCategorySlugs } from "@/lib/queries/taxonomy";
import { pageMetadata } from "@/lib/metadata";
import { staticParamsOrEmpty } from "@/lib/static-params";

/**
 * `/directory/[category]`: one category, ISR (1h).
 *
 * Don't read `searchParams`, `cookies()` or `auth()` here or the route turns dynamic and
 * `revalidate` stops applying. Filtering links to `/directory`, which owns query state.
 * Static params cover every category, including empty ones (rendered, not 404).
 */

export const revalidate = 3600;

interface CategoryPageProps {
  params: Promise<{ category: string }>;
}

export async function generateStaticParams() {
  // Tolerates a build with no database.
  return staticParamsOrEmpty("/directory/[category]", async () => {
    const slugs = await listCategorySlugs();
    return slugs.map((category) => ({ category }));
  });
}

export async function generateMetadata({ params }: CategoryPageProps) {
  const { category: slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) return pageMetadata({ title: "Not found", description: "", path: `/directory/${slug}`, index: false });

  return pageMetadata({
    title: category.name,
    description:
      category.description ??
      `Open-source intelligence tools and data sources in ${category.name}, each with its cost, jurisdiction, and the date a human last checked it.`,
    path: `/directory/${category.slug}`,
  });
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { category: slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) notFound();

  const page = await listTools({
    q: "",
    category: category.slug,
    tags: [],
    cost: [],
    input: [],
    output: [],
    confidence: [],
    sort: "name",
    page: 1,
  });

  const refineHref = `/directory?category=${encodeURIComponent(category.slug)}`;
  const more = page.total > page.items.length;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[{ label: "directory", href: "/directory" }, { label: category.name }]}
      />

      <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">{category.name}</h1>
      {category.description ? (
        <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">
          {category.description}
        </p>
      ) : null}

      {page.total > 0 ? (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <p className="tabular text-xs text-muted-foreground">
              {page.total === 1 ? "1 tool" : `${page.total} tools`} · sorted by name
            </p>
            <Button asChild variant="outline">
              <Link href={refineHref}>filter and sort these</Link>
            </Button>
          </div>

          <div className="mt-4">
            <ToolGrid>
              {page.items.map((tool) => (
                <li key={tool.id} className="h-full">
                  <ToolCard tool={tool} />
                </li>
              ))}
            </ToolGrid>
          </div>

          {more ? (
            <p className="mt-8 text-sm text-foreground-secondary">
              Showing the first {DIRECTORY_PAGE_SIZE} of {page.total} by name.{" "}
              <Link
                href={refineHref}
                className="font-medium text-primary underline underline-offset-4"
              >
                Open this category in the directory
              </Link>{" "}
              to page through the rest, sort them, or narrow by cost, input type or confidence.
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-8">
          <EmptyCollection name={category.name} kind="category" />
        </div>
      )}
    </div>
  );
}
