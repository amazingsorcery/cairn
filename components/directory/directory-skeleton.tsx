import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `/directory` loading state, used as an in-page `<Suspense>` fallback.
 *
 * Not a `loading.tsx`: that boundary would also wrap `/directory/[category]`, and once a
 * fallback streams the status is sent, so `notFound()` there would return 200.
 *
 * Filters are drawn as bars rather than unchecked controls that would misstate the URL's
 * filters.
 */
export function DirectoryBodySkeleton() {
  return (
    <>
      <p aria-live="polite" className="sr-only">
        Loading directory entries…
      </p>

      <div className="mt-8 grid gap-8 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="hidden md:block" aria-hidden="true">
          <Skeleton className="h-4 w-16" />
          {Array.from({ length: 4 }, (_, group) => (
            <div key={group} className="mt-6 space-y-2">
              <Skeleton className="h-3.5 w-24" />
              {Array.from({ length: 4 }, (_, row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </div>
          ))}
        </div>

        <div className="min-w-0">
          <div className="flex flex-col gap-3 sm:flex-row" aria-hidden="true">
            <Skeleton className="h-11 flex-1" />
            <Skeleton className="h-11 w-40" />
          </div>
          <Skeleton className="mt-4 h-4 w-40" aria-hidden="true" />
          <div className="mt-4">
            <div className="xl:hidden">
              <ToolGridSkeleton count={6} />
            </div>
            <div className="hidden xl:block">
              <ToolGridSkeleton count={9} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
