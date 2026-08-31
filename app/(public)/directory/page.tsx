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
 * `/directory` — the filtered, paginated catalogue.
 *
 * **Dynamic on purpose** (`docs/architecture/sitemap.md` §1). This route reads
 * `searchParams`, which opts it out of the Full Route Cache in Next 15 whatever `revalidate`
 * says — so `revalidate` is deliberately NOT exported here (architecture HANDOFF §8, "the
 * trap", and QA assertion 11). The expensive part is still cached: `listTools()` wraps the
 * SQL in `unstable_cache` keyed by the *normalised* filter tuple, so the unfiltered first
 * page is one entry shared by every visitor and a crafted query string cannot mint new ones.
 *
 * Everything on this page is a Server Component except three leaves: the facet inputs, the
 * sort select and the name field (`components/directory/filter-controls.tsx`), plus the sheet
 * that holds the facets at 375px. The result list never crosses the client boundary.
 *
 * **There is deliberately no `loading.tsx` in this segment.** A route-level `loading.tsx`
 * wraps child segments too, and a Suspense fallback that streams commits the HTTP status
 * line — which made `notFound()` in `/directory/[category]` return `200 OK` instead of 404
 * (finding I-15). The skeleton lives in an in-page `<Suspense>` below instead, where it wraps
 * only this page's own body. Do not reintroduce `app/(public)/directory/loading.tsx`.
 *
 * STATES BUILT HERE — `docs/design/states.md` §2:
 *   §2.1 zero results, naming the computed widest single removal
 *   §2.2 delegated to `/directory/[category]` and `/tags/[slug]`
 *   §2.3 the skeleton, as an in-page `<Suspense>` fallback — see the shell below
 *   §2.4 the list query failed — in-region, filter bar still live
 *   §2.5 facet counts unavailable — checkboxes render without them
 *   §2.6 success
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

/**
 * The catalogue read, degraded rather than thrown.
 *
 * A failure here must not take the filter bar down with it (`states.md` §2.4), so the error
 * is carried in the return value and rendered in-region. Next's `error.tsx` still covers
 * anything thrown outside this boundary.
 */
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
 * The page shell. It touches no database, so it paints immediately and the Suspense boundary
 * below is the only thing that waits — which is what keeps the skeleton out of the segment
 * boundary that was breaking `/directory/[category]`'s 404 (finding I-15).
 *
 * The `<Suspense>` is deliberately UNKEYED. Keying it on the filter tuple would remount the
 * subtree on every filter change, which would tear down the client leaves inside it: the open
 * mobile filter sheet would slam shut on each checkbox tick. Unkeyed, React reconciles the
 * client components by position and they keep their state, while the in-flight styling comes
 * from the `useTransition` pending state in `DirectoryFilters` — which is the behaviour
 * `states.md` §2.3 and shell handoff §10.1 describe anyway: announce the new count, do not
 * move the reader.
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
        The second skip link — WCAG 2.4.1, technique G123.

        The shell's own skip link targets `#main`, and `#main` CONTAINS the filter panel, so it
        is no help in bypassing it (audit Q-21). With the results now ahead of the filters in
        DOM order, the traverse that needs bypassing is the other one: a keyboard reader who
        wants to filter would otherwise tab through every result card to get there.

        It is `md:` and up because that is exactly where the sidebar exists. Below `md:` the
        facets live in the sheet, whose trigger is three stops into the toolbar — a skip link
        to a `display:none` sidebar would be a link to nowhere.
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
   * `states.md` §2.1 requires the empty state to name the single filter whose removal widens
   * the result set most, "computed, not guessed: the backend returns, alongside the empty
   * result set, the count each active filter would yield if it alone were dropped". There is
   * no such combined query in `lib/queries`, so the page runs the same cached list query once
   * per active filter. It fires ONLY on a zero-result page — never on the hot path — and
   * every call is an `unstable_cache` hit after the first, keyed on the normalised tuple.
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
   * Each form owns part of the tuple and mirrors the rest. The facet panel owns the six
   * facet keys and carries `q` and `sort`; the toolbar owns `q` and `sort` and carries the
   * six facets. A GET form submits only what it contains, so without the mirror, changing a
   * checkbox would silently drop the reader's query.
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
          DOM ORDER IS RESULTS FIRST, FILTERS SECOND — audit finding Q-21, WCAG 2.4.1.

          Visually the sidebar is still on the left at `md:` and above: `md:col-start-*` plus
          `md:row-start-1` place both children explicitly, so the grid ignores source order
          and the design is unchanged. What changes is the TAB order. A keyboard reader used
          to pass 351 facet controls — 366 stops in all — before reaching the first catalogue
          entry; now the results come first and the facet panel follows.

          The reverse trip is served by the "skip to filters" link in the page shell, so
          neither direction costs a traverse of the other. Do not "tidy" this back into
          source order.
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
 * The facet groups.
 *
 * Counts render for `category` and `tag` because `listCategories()` and `listTags()` return
 * them. Cost, confidence, input and output carry `null` — the read layer has no facet-count
 * query for them, and `states.md` §2.5 is explicit that a checkbox renders without its count
 * rather than not rendering. A guessed or zero count would be a claim nobody measured, which
 * is the one thing this catalogue may not print. See `docs/frontend/HANDOFF-directory.md` for
 * the query this needs.
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
