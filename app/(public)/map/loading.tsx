import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * First load of `/map` only; refreshes keep current features on screen while revalidating.
 * Skeletons are `aria-hidden`; the text line is the announcement.
 */
export default function LoadingMap() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="flex items-center gap-2 text-sm text-foreground-secondary">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <p aria-live="polite">Loading map layers…</p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem]" aria-hidden="true">
        <Skeleton className="h-[55vh] min-h-[18rem] w-full md:h-[65vh]" />
        <Skeleton className="h-40 w-full" />
      </div>
      <Skeleton className="mt-6 h-64 w-full" aria-hidden="true" />
    </div>
  );
}
