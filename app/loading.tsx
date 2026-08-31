import { Skeleton } from "@/components/ui/skeleton";

/**
 * The root loading fallback.
 *
 * **This file cascades.** In the App Router a `loading.tsx` at `app/` covers `app/page.tsx`
 * and every descendant segment that has no `loading.tsx` of its own. It is therefore written
 * as a neutral page shell — a heading, a lead line, a band of blocks in the standard
 * container — and not as a home-page-specific skeleton. A route that wants a skeleton
 * matching its own layout adds its own `loading.tsx`, which takes precedence; `/directory`,
 * `/directory/[category]`, `/tags/[slug]`, `/tools/[slug]` and `/search` all do.
 *
 * The blocks are `aria-hidden` (they come from `Skeleton`) and the single `aria-live` region
 * below is the accessible signal — shell handoff §10.1, `states.md` §0: a screen reader
 * reading out a grid of empty boxes is worse than silence.
 *
 * Never a bare spinner. `states.md` §0: the product has exactly two, on `/live/flights` and
 * PDF generation, and both carry text saying what is happening.
 */
export default function RootLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading this page…
      </p>

      <div aria-hidden="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-6 w-full max-w-[44rem]" />
        <Skeleton className="mt-2 h-6 w-full max-w-[32rem]" />

        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-36" />
          ))}
        </div>
      </div>
    </div>
  );
}
