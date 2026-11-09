import { Suspense } from "react";

import { ActiveFilterChips } from "@/components/directory/active-filters";
import { DirectoryBodySkeleton } from "@/components/directory/directory-skeleton";
import { DirectoryToolbar } from "@/components/directory/directory-toolbar";
import {
  CONFIDENCE_OPTIONS,
  COST_OPTIONS,
  INPUT_OPTIONS,
  OUTPUT_NOTE,
  OUTPUT_OPTIONS,
  confidenceValueLabel,
  costLabel,
  sortLabel,
  typeLabel,
} from "@/components/directory/facets";
import { DirectoryFilters, ResultsRegion } from "@/components/directory/filter-controls";
import { FilterPanel, type FacetGroup } from "@/components/directory/filter-panel";
import { FilterSheet } from "@/components/directory/filter-sheet";
import {
  activeFilters,
  clearedFilters,
  filtersHref,
  hiddenPairs,
  withPage,
} from "@/components/directory/filter-url";
import { EmptyResults } from "@/components/directory/empty-results";
import { Pagination } from "@/components/directory/pagination";
import { RegionError } from "@/components/directory/region-error";
import { ToolCard, ToolGrid } from "@/components/directory/tool-card";
import type { ConfidenceLevel } from "@/db/schema";
import { listTools, type ToolListPage } from "@/lib/queries/tools";
import { listCategories, listTags } from "@/lib/queries/taxonomy";
import { logger } from "@/lib/logger";
import { pageMetadata } from "@/lib/metadata";
import { parseDirectoryFilters, type DirectoryFilters as Filters } from "@/lib/validation/filters";

/**
 * `/directory`: the filtered, paginated catalogue.
 *
 * Dynamic because it reads `searchParams`, so no `revalidate` export. `listTools()` caches
 * by the normalised filter tuple, so crafted query strings can't mint new cache entries.
 *
 * No `loading.tsx` in this segment: it would wrap `/directory/[category]` too and its
 * streamed fallback would turn that route's 404s into 200s. The skeleton is an in-page
 * `<Suspense>` instead.
 */

export const metadata = pageMetadata({
  title: "Directory",
  description:
    "A filterable catalogue of open-source intelligence tools and data sources. Every entry states its cost, jurisdiction, input and output types, and the date a human last checked it.",
  path: "/directory",
});

const BASE = "/directory";

interface DirectoryPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Returns null on failure so the error renders in-region and the filter bar stays usable. */
async function readTools(filters: Filters): Promise<ToolListPage | null> {
  try {
    return await listTools(filters);
  } catch (error) {
    logger.error({ scope: "directory", err: error }, "Directory list query failed");
    return null;
  }
}

/** Taxonomy is only needed for facet labels and counts; without it the facets still work. */
async function readTaxonomy() {
  const [categories, tags] = await Promise.allSettled([listCategories(), listTags()]);
  return {
    categories: categories.status === "fulfilled" ? categories.value : null,
    tags: tags.status === "fulfilled" ? tags.value : null,
  };
}

/**
 * Page shell; touches no database, so it paints immediately.
 *
 * The `<Suspense>` is unkeyed: keying it on the filters would remount the client leaves and
 * close the open mobile filter sheet on every tick. Pending styling comes from
 * `useTransition` in `DirectoryFilters`.
 */
export default async function DirectoryPage({ searchParams }: DirectoryPageProps) {
  const filters = parseDirectoryFilters(await searchParams);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Directory</h1>
      <p className="text-foreground-secondary mt-3 max-w-[68ch] text-lg">
        Open-source intelligence tools and data sources. Every entry states what it takes in, what
        it gives back, what it costs, whose jurisdiction the data sits in, and the date a human last
        checked our record of it.
      </p>

      {/*
        Skip link past the results to the filter sidebar (WCAG 2.4.1). `md:` only, since
        below that the sidebar is hidden and facets live in the sheet.
      */}
      <a
        href="#directory-filters"
        className="focus:border-input sr-only focus:not-sr-only focus:mt-4 focus:inline-flex focus:h-11 focus:items-center focus:rounded-md focus:border focus:px-4 focus:text-sm focus:font-medium md:focus:not-sr-only"
      >
        skip to filters
      </a>

      <Suspense fallback={<DirectoryBodySkeleton />}>
        <DirectoryBody filters={filters} />
      </Suspense>
    </div>
  );
}

/** Everything that needs the database. Suspends; the shell above does not. */
async function DirectoryBody({ filters }: { filters: Filters }) {
  const [page, taxonomy] = await Promise.all([readTools(filters), readTaxonomy()]);

  const categories = taxonomy.categories ?? [];
  const tags = taxonomy.tags ?? [];
  const countsUnavailable = taxonomy.categories === null || taxonomy.tags === null;

  const categoryNames = new Map(categories.map((c) => [c.slug, c.name]));
  const tagNames = new Map(tags.map((t) => [t.slug, t.name]));

  const chips = activeFilters(filters, { categoryNames, tagNames });
  const clearHref = filtersHref(BASE, clearedFilters());

  /**
   * On zero results, find the single filter whose removal yields the most results by
   * re-running the cached list query once per active filter. Only runs on empty pages.
   */
  let widest: { label: string; href: string; total: number } | null = null;
  if (page !== null && page.total === 0 && chips.length > 0) {
    const measured = await Promise.all(
      chips.map(async (chip) => {
        try {
          const { total } = await listTools(chip.without);
          return { chip, total };
        } catch {
          return null;
        }
      }),
    );
    for (const candidate of measured) {
      if (!candidate || candidate.total === 0) continue;
      if (widest === null || candidate.total > widest.total) {
        widest = {
          label: candidate.chip.label,
          href: filtersHref(BASE, candidate.chip.without),
          total: candidate.total,
        };
      }
    }
  }

  const groups = buildGroups(filters, categories, tags);
  /**
   * Each GET form carries the other form's params as hidden inputs, otherwise changing a
   * facet would drop `q`/`sort` and vice versa.
   */
  const facetHidden = hiddenPairs(filters, [
    "category",
    "tag",
    "cost",
    "input",
    "output",
    "confidence",
  ]);
  const toolbarHidden = hiddenPairs(filters, ["q", "sort"]);

  const total = page?.total ?? 0;
  const announcement =
    page === null
      ? "The directory list could not be loaded."
      : total === 1
        ? "1 tool matches these filters"
        : `${total} tools match these filters`;

  const countsNote = countsUnavailable
    ? "Result counts are unavailable right now. The filters still work."
    : undefined;

  return (
    <DirectoryFilters>
      <div className="mt-8 grid gap-8 md:grid-cols-[16rem_minmax(0,1fr)]">
        {/*
          Results come before filters in DOM order so keyboard users don't tab through
          hundreds of facet controls first. Grid placement keeps the sidebar visually left.
        */}
        <div className="min-w-0 md:col-start-2 md:row-start-1">
          <DirectoryToolbar
            action={BASE}
            q={filters.q}
            sort={filters.sort}
            hidden={toolbarHidden}
            sheet={
              <FilterSheet activeCount={chips.length} total={total} clearHref={clearHref}>
                <FilterPanel
                  action={BASE}
                  idPrefix="sheet"
                  groups={groups}
                  hidden={facetHidden}
                  className="h-full"
                  {...(countsNote ? { countsNote } : {})}
                />
              </FilterSheet>
            }
          />

          <ActiveFilterChips
            filters={chips}
            hrefFor={(chip) => filtersHref(BASE, chip.without)}
            clearHref={clearHref}
            className="mt-4"
          />

          <p className="tabular text-muted-foreground mt-4 text-xs">
            {page === null
              ? " "
              : `${total === 1 ? "1 tool" : `${total} tools`} · sorted by ${sortLabel(filters.sort)}`}
          </p>

          <ResultsRegion
            announcement={announcement}
            loadingAnnouncement="Loading directory entries…"
          >
            <div className="mt-4">
              {page === null ? (
                <RegionError
                  title="Couldn't load these results"
                  description="The query failed. Retry, or clear the filters and start again."
                  secondary={{ label: "clear all filters", href: clearHref }}
                />
              ) : page.total === 0 ? (
                <EmptyResults activeCount={chips.length} widest={widest} clearHref={clearHref} />
              ) : (
                <>
                  <ToolGrid>
                    {page.items.map((tool) => (
                      <li key={tool.id} className="h-full">
                        <ToolCard tool={tool} />
                      </li>
                    ))}
                  </ToolGrid>
                  <Pagination
                    page={page.page}
                    pageCount={page.pageCount}
                    hrefForPage={(next) => filtersHref(BASE, withPage(filters, next))}
                    className="mt-8"
                  />
                </>
              )}
            </div>
          </ResultsRegion>
        </div>

        <aside
          id="directory-filters"
          tabIndex={-1}
          aria-labelledby="directory-filters-heading"
          className="hidden md:sticky md:top-20 md:col-start-1 md:row-start-1 md:block md:self-start"
        >
          <h2
            id="directory-filters-heading"
            className="text-muted-foreground mb-4 text-xs font-semibold tracking-wide uppercase"
          >
            filters
          </h2>
          <FilterPanel
            action={BASE}
            idPrefix="sidebar"
            groups={groups}
            hidden={facetHidden}
            className="max-h-[calc(100dvh-8rem)]"
            {...(countsNote ? { countsNote } : {})}
          />
        </aside>
      </div>
    </DirectoryFilters>
  );
}

/**
 * Facet groups. Only category and tag have counts; the others pass `null` (no count shown)
 * because there's no facet-count query for them yet.
 */
function buildGroups(
  filters: Filters,
  categories: readonly { slug: string; name: string; toolCount: number }[],
  tags: readonly { slug: string; name: string; toolCount: number }[],
): FacetGroup[] {
  const groups: FacetGroup[] = [
    {
      id: "category",
      legend: "category",
      kind: "radio",
      name: "category",
      options: [
        { value: "", label: "all categories", count: null, checked: !filters.category },
        ...categories.map((category) => ({
          value: category.slug,
          label: category.name,
          count: category.toolCount,
          checked: filters.category === category.slug,
        })),
      ],
    },
    {
      id: "cost",
      legend: "cost model",
      kind: "checkbox",
      name: "cost",
      options: COST_OPTIONS.map((value) => ({
        value,
        label: costLabel(value),
        count: null,
        checked: filters.cost.includes(value),
      })),
    },
    {
      id: "confidence",
      legend: "confidence",
      kind: "checkbox",
      name: "confidence",
      options: CONFIDENCE_OPTIONS.map((value) => ({
        value,
        label: confidenceValueLabel(value),
        count: null,
        checked: filters.confidence.includes(value),
        confidence: value as ConfidenceLevel,
      })),
    },
    {
      id: "input",
      legend: "input type",
      kind: "checkbox",
      name: "input",
      collapsible: true,
      scroll: true,
      options: INPUT_OPTIONS.map((value) => ({
        value,
        label: typeLabel(value),
        count: null,
        checked: filters.input.includes(value),
      })),
    },
    {
      id: "output",
      legend: "output type",
      kind: "checkbox",
      name: "output",
      collapsible: true,
      note: OUTPUT_NOTE,
      scroll: true,
      options: OUTPUT_OPTIONS.map((value) => ({
        value,
        label: typeLabel(value),
        count: null,
        checked: filters.output.includes(value),
      })),
    },
  ];

  if (tags.length > 0) {
    groups.push({
      id: "tag",
      legend: "tag",
      kind: "checkbox",
      name: "tag",
      collapsible: true,
      scroll: true,
      options: tags.map((tag) => ({
        value: tag.slug,
        label: tag.name,
        count: tag.toolCount,
        checked: filters.tags.includes(tag.slug),
      })),
    });
  }

  return groups;
}
