import { ToolGridSkeleton } from "@/components/directory/tool-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * No filter rail here; facets live on `/directory`. Card skeletons reserve the confidence
 * chip and last-verified line so the layout doesn't jump.
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
