import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `docs/design/states.md` §2.3.
 *
 * Six card skeletons at 375px and nine at 1280px — the grid is one, two and three columns, so
 * nine placeholders fill three rows on a wide screen and the extra three are hidden below
 * `xl:` rather than rendered as a fourth mobile row nobody asked for.
 *
 * The skeletons are `aria-hidden` (they come from `Skeleton`); the single `aria-live` region
 * below is the accessible signal, per shell handoff §10.1. There is exactly one live region
 * on this route: this file's, and then the page's own once the data arrives.
 *
 * The filter panel is drawn as bars rather than as real controls. It renders from the URL and
 * needs no data, but a `loading.tsx` cannot read `searchParams`, so drawing real checkboxes
 * here would mean drawing them all unchecked — a filter bar that briefly lies about the
 * filters in the address.
 */
export default function DirectoryLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-4 h-6 w-full max-w-[48rem]" />

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
    </div>
  );
}
