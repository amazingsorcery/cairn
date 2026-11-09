import { SearchSkeleton } from "@/components/directory/search-results";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/search` loading state. The field is a skeleton bar because `loading.tsx` can't read
 * `searchParams`, so a real input would flash empty.
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
