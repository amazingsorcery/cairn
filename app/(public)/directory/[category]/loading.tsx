import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `states.md` §2.3, for the single-category listing. No filter rail to reserve on this route:
 * the facets live on `/directory`, which is where query state belongs.
 *
 * One `aria-live` region, skeletons `aria-hidden` (shell handoff §10.1). Every card
 * placeholder reserves the confidence chip and the last-verified line so the layout does not
 * jump and an entry never appears, even for a frame, to have no confidence value.
 */
export default function CategoryLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-4 h-8 w-64" />
      <Skeleton className="mt-4 h-6 w-full max-w-[44rem]" />

      <p aria-live="polite" className="sr-only">
        Loading directory entries…
      </p>

      <Skeleton className="mt-6 h-4 w-32" />
      <div className="mt-4">
        <div className="xl:hidden">
          <ToolGridSkeleton count={6} />
        </div>
        <div className="hidden xl:block">
          <ToolGridSkeleton count={9} />
        </div>
      </div>
    </div>
  );
}
