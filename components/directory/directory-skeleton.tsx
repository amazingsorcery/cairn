import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The `/directory` loading state — `docs/design/states.md` §2.3.
 *
 * WHY THIS IS A COMPONENT AND NOT A `loading.tsx`
 * ----------------------------------------------
 * It used to be `app/(public)/directory/loading.tsx`. A `loading.tsx` creates a Suspense
 * boundary that wraps **the whole segment subtree, child segments included** — so it also
 * wrapped `/directory/[category]`. Next streams a Suspense fallback as soon as it reaches it,
 * and streaming sends the HTTP status line; a `notFound()` thrown later swaps the body but
 * cannot change the status. `/directory/nope` was therefore served as `200 OK` with
 * `s-maxage=3600`: a correct-looking 404 that a crawler indexes as real content and a CDN
 * caches for an hour. Finding I-15 in `docs/integration-findings.md`.
 *
 * The segment `layout.tsx` guard that fixed the other dynamic routes cannot fix this one — a
 * layout renders above its OWN loading boundary, but the parent's boundary is already open by
 * then.
 *
 * So the skeleton moved in-page: `/directory/page.tsx` wraps its data-dependent body in a
 * `<Suspense>` using this as the fallback. The boundary now sits INSIDE the route's own page
 * and wraps nothing belonging to the child segment, so `/directory/[category]` streams its own
 * status and its `notFound()` is a real 404.
 *
 * The state itself is unchanged and was never up for deletion: `/directory` is dynamic, it
 * genuinely waits on a query, and a blank screen during navigation is a worse product than a
 * wrong status code on a bogus slug.
 *
 * Six card skeletons at 375px and nine at 1280px — the grid is one, two and three columns, so
 * nine fills three rows on a wide screen and the extra three stay hidden below `xl:` rather
 * than becoming a fourth mobile row nobody asked for.
 *
 * Skeletons are `aria-hidden` (they come from `Skeleton`); the single `aria-live` region is
 * the accessible signal, per shell handoff §10.1. The heading and lead are NOT here — they
 * render synchronously above the boundary now, so they never flash as bars.
 *
 * The filter panel is drawn as bars rather than as real controls. It renders from the URL and
 * needs no data, but drawing real checkboxes in a fallback would mean drawing them all
 * unchecked — a filter bar that briefly lies about the filters in the address.
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
