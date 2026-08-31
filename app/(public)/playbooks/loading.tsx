import { Skeleton } from "@/components/ui/skeleton";

/**
 * First paint for `/playbooks`.
 *
 * The skeletons are `aria-hidden` (the `Skeleton` primitive sets it) and the single polite
 * live region carries the announcement — a screen reader reading out a grid of empty boxes
 * is worse than silence (`docs/design/states.md` §0).
 *
 * Each card reserves the space its confidence chip and last-verified line will occupy,
 * because those two are not optional anywhere and a skeleton that omits them shifts the
 * layout when the real card arrives.
 */
export default function PlaybooksLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading playbooks…
      </p>

      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-4 h-6 w-full max-w-[52ch]" />

      <div className="mt-8 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card p-5">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-1.5 h-4 w-5/6" />
            <div className="mt-4 flex gap-2">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-4 h-5 w-32 rounded-full" />
            <Skeleton className="mt-2 h-4 w-48" />
          </div>
        ))}
      </div>
    </div>
  );
}
