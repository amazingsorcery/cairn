import { SearchSkeleton } from "@/components/directory/search-results";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/search` while the query runs.
 *
 * The field is drawn as a bar rather than as a real input: a `loading.tsx` cannot read
 * `searchParams`, so a real field here would render empty and then be replaced by one holding
 * the query — a search box that appears to have lost what you typed.
 *
 * Each row placeholder reserves the confidence chip and the last-verified line, which are not
 * optional on a search result row either (architecture HANDOFF §9.1).
 */
export default function SearchLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Skeleton className="h-8 w-32" />

      <p aria-live="polite" className="sr-only">
        Running your search…
      </p>

      <div className="mt-6 max-w-2xl" aria-hidden="true">
        <Skeleton className="h-11 w-full" />
      </div>

      <div className="mt-8" aria-hidden="true">
        <Skeleton className="h-4 w-64" />
        <div className="mt-4 grid grid-cols-1 gap-8 xl:grid-cols-2">
          <div>
            <Skeleton className="h-3.5 w-24" />
            <div className="mt-3">
              <SearchSkeleton count={3} />
            </div>
          </div>
          <div>
            <Skeleton className="h-3.5 w-28" />
            <div className="mt-3">
              <SearchSkeleton count={2} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
