import Link from "next/link";
import { Info } from "lucide-react";

import { RegionError } from "@/components/directory/region-error";
import { SearchField } from "@/components/directory/search-field";
import {
  PlaybookHitRow,
  ResultList,
  ToolHitRow,
} from "@/components/directory/search-results";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { search, type SearchResults } from "@/lib/queries/search";
import { listCategories } from "@/lib/queries/taxonomy";
import { logger } from "@/lib/logger";
import { pageMetadata } from "@/lib/metadata";
import { parseSearchFilters } from "@/lib/validation/filters";
import { cn } from "@/lib/utils";

/**
 * `/search`: tools and playbooks in two ranked groups.
 *
 * Dynamic (reads `searchParams`), so no `revalidate`; `search()` caches the SQL for 60s.
 * Left out of `sitemap.xml` but not `noindex`, so crawlers can still follow result links.
 *
 * A failure in one group fails both, since `search()` runs them together.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Search",
  description:
    "Search the catalogue of open-source intelligence tools and the playbooks that use them. Every result carries our confidence in the entry and the date a human last checked it.",
  path: "/search",
});

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const filters = parseSearchFilters(await searchParams);

  let results: SearchResults | null = null;
  let failed = false;

  if (filters.q) {
    try {
      results = await search(filters);
    } catch (error) {
      logger.error({ scope: "search", err: error }, "Search query failed");
      failed = true;
    }
  }

  // Only needed for the empty-query state; failures are ignored.
  const categories = filters.q
    ? []
    : await listCategories()
        .then((rows) => rows.filter((row) => row.toolCount > 0))
        .catch(() => []);

  const toolTotal = results?.toolTotal ?? 0;
  const playbookTotal = results?.playbookTotal ?? 0;
  const fuzzy = results?.didYouMean ?? [];
  const nothingMatched = results !== null && toolTotal === 0 && playbookTotal === 0;

  const announcement = buildAnnouncement({
    query: filters.q,
    failed,
    results,
    toolTotal,
    playbookTotal,
    fuzzyCount: fuzzy.length,
  });

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Search</h1>

      <div className="mt-6 max-w-2xl">
        <SearchField initialQuery={filters.q} />
      </div>

      {/*
        Live region exists before results render (otherwise nothing is announced);
        `aria-atomic="false"` so only the new count is read.
      */}
      <section aria-live="polite" aria-atomic="false" aria-label="Search results" className="mt-8">
        <p className="sr-only">{announcement}</p>

        {failed ? (
          <RegionError
            title="Couldn't run that search"
            description="The search index didn't answer. Retry, or browse the directory by category."
            secondary={{ label: "browse the directory", href: "/directory" }}
          />
        ) : !filters.q ? (
          /* Empty query: not an error. */
          <div>
            <p className="max-w-[60ch] text-base text-foreground-secondary">
              Search across the catalogue and the playbooks. Results carry our confidence in the
              entry and the date a human last checked it.
            </p>
            {categories.length > 0 ? (
              <div className="mt-8">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  browse by category
                </h2>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {categories.map((category) => (
                    <li key={category.slug}>
                      <Link
                        href={`/directory/${category.slug}`}
                        className={cn(
                          "inline-flex min-h-11 items-center gap-2 rounded-full border border-border",
                          "bg-card px-4 text-sm hover:border-foreground-faint hover:bg-accent",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        )}
                      >
                        {category.name}
                        <span className="tabular text-xs text-muted-foreground">
                          {category.toolCount}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : nothingMatched && fuzzy.length === 0 ? (
          /* No matches. The query stays in the field for editing. */
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold tracking-tight">
              Nothing matches &ldquo;{filters.q}&rdquo;
            </h2>
            <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-foreground-secondary">
              Try fewer words, or browse the directory by category.
            </p>
            <div className="mt-6">
              <Button asChild size="lg" variant="outline">
                <Link href="/directory">browse the directory</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/*
              Fuzzy fallback: `didYouMean` is only set when both groups are empty. It's a
              `pg_trgm` name match on a different scale from `ts_rank_cd`, so it's shown as a
              separate, labelled group rather than merged into results.
            */}
            {fuzzy.length > 0 ? (
              <div className="mb-6">
                <Alert variant="info">
                  <Info aria-hidden="true" />
                  <AlertTitle>
                    No exact matches for &ldquo;{filters.q}&rdquo;
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      These entries have similar names. They were found by spelling, not by
                      meaning, so read them as suggestions rather than as results.
                    </p>
                  </AlertDescription>
                </Alert>

                <ul className="mt-4 grid grid-cols-1 gap-3">
                  {fuzzy.map((hit) => (
                    <li key={hit.slug}>
                      <Link
                        href={`/tools/${hit.slug}`}
                        className={cn(
                          "block rounded-lg border border-border bg-card p-4",
                          "hover:border-foreground-faint hover:bg-accent",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        )}
                      >
                        <span className="text-base font-semibold tracking-tight">{hit.name}</span>
                        <span className="mt-1 block text-sm text-foreground-secondary">
                          {hit.summary}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {results && (toolTotal > 0 || playbookTotal > 0) ? (
              <>
                <p className="tabular text-xs text-muted-foreground">
                  {toolTotal === 1 ? "1 tool" : `${toolTotal} tools`} ·{" "}
                  {playbookTotal === 1 ? "1 playbook" : `${playbookTotal} playbooks`} for &ldquo;
                  {filters.q}&rdquo;
                </p>

                {/* Two columns on wide screens, stacked on mobile; tools first. */}
                <div className="mt-4 grid grid-cols-1 gap-8 xl:grid-cols-2">
                  <section aria-labelledby="tools-heading">
                    <h2
                      id="tools-heading"
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      tools ({toolTotal})
                    </h2>
                    <div className="mt-3">
                      {results.tools.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">
                          No tool matches &ldquo;{filters.q}&rdquo;.
                        </p>
                      ) : (
                        <ResultList>
                          {results.tools.map((hit) => (
                            <ToolHitRow key={hit.slug} hit={hit} />
                          ))}
                        </ResultList>
                      )}
                    </div>
                  </section>

                  <section aria-labelledby="playbooks-heading">
                    <h2
                      id="playbooks-heading"
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      playbooks ({playbookTotal})
                    </h2>
                    <div className="mt-3">
                      {results.playbooks.length === 0 ? (
                        <p className="text-sm text-foreground-secondary">
                          No playbook matches &ldquo;{filters.q}&rdquo;.
                        </p>
                      ) : (
                        <ResultList>
                          {results.playbooks.map((hit) => (
                            <PlaybookHitRow key={hit.slug} hit={hit} />
                          ))}
                        </ResultList>
                      )}
                    </div>
                  </section>
                </div>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/** Screen-reader announcement for the current results, including the fuzzy fallback case. */
function buildAnnouncement({
  query,
  failed,
  results,
  toolTotal,
  playbookTotal,
  fuzzyCount,
}: {
  query: string;
  failed: boolean;
  results: SearchResults | null;
  toolTotal: number;
  playbookTotal: number;
  fuzzyCount: number;
}): string {
  if (failed) return "The search could not be run.";
  if (!query) return "Type a query to search the catalogue.";
  if (results === null) return "";
  if (fuzzyCount > 0) {
    return `No exact matches for ${query}. Showing ${fuzzyCount} ${
      fuzzyCount === 1 ? "entry" : "entries"
    } with similar names.`;
  }
  if (toolTotal === 0 && playbookTotal === 0) return `Nothing matches ${query}.`;
  return `${toolTotal} ${toolTotal === 1 ? "tool" : "tools"} and ${playbookTotal} ${
    playbookTotal === 1 ? "playbook" : "playbooks"
  } match ${query}.`;
}
