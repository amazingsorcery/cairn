import { Skeleton } from "@/components/ui/skeleton";

/**
 * The detail page's skeleton.
 *
 * `states.md` §0 and the "confidence and last-verified are not optional anywhere" rule: "A
 * skeleton for an entry reserves their space." The two blocks below the summary are the
 * confidence chip and the last-verified line, so the header does not reflow when the entry
 * arrives — and so that neither ever appears, even for a frame, to be absent.
 *
 * One `aria-live` region; everything else is `aria-hidden` via `Skeleton`.
 */
export default function ToolLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading this entry…
      </p>

      <div aria-hidden="true">
        <Skeleton className="h-4 w-64" />

        <div className="mt-4 max-w-[68ch]">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="mt-3 h-4 w-48" />
          <Skeleton className="mt-4 h-6 w-full" />
          <Skeleton className="mt-2 h-6 w-4/5" />
          <div className="mt-5 flex flex-wrap items-center gap-4">
            {/* reserved: confidence chip */}
            <Skeleton className="h-6 w-36 rounded-full" />
            {/* reserved: last verified */}
            <Skeleton className="h-5 w-56" />
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-10">
          <div className="space-y-6 xl:order-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-56 w-full rounded-lg" />
          </div>
          <div className="min-w-0 space-y-8 xl:order-1">
            <div>
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="mt-3 h-4 w-full max-w-[60ch]" />
              <Skeleton className="mt-2 h-4 w-4/5 max-w-[52ch]" />
            </div>
            <Skeleton className="h-32 w-full rounded-lg" />
            <div>
              <Skeleton className="h-3.5 w-24" />
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="mt-2 h-4 w-full max-w-[64ch]" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
