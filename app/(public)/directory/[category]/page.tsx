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
 * `/directory/[category]` — one category, prerendered.
 *
 * **ISR:3600** (architecture HANDOFF §8). This route reads NO `searchParams`, calls no
 * `cookies()` and no `auth()`; if it ever did, `revalidate` below would silently stop meaning
 * anything (HANDOFF §8 "the trap", QA assertion 11). The refine control is a link into
 * `/directory`, which is the route that owns query state — that separation is what keeps this
 * page static and shareable.
 *
 * `generateStaticParams` covers **every** category slug, not only the non-empty ones:
 * `listCategorySlugs()` says so in its own comment, and `states.md` §2.2 makes an empty
 * category a legitimate rendered state rather than a 404. A category that exists and has
 * nothing in it is a true thing to say; a 404 would be a false one.
 */

export const revalidate = 3600;

interface CategoryPageProps {
  params: Promise<{ category: string }>;
}

export async function generateStaticParams() {
  // Tolerates a build with no database — see ADR 0018.
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
