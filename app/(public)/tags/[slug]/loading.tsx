import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * `states.md` §2.3, for a tag listing. One `aria-live` region; skeletons are `aria-hidden`
 * and reserve the confidence chip and last-verified line (shell handoff §10.1).
 */
export default function TagLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-4 h-8 w-56" />
      <Skeleton className="mt-4 h-6 w-full max-w-[40rem]" />

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
