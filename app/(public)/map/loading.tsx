import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * The first load of `/map`, before any source has answered.
 *
 * IT APPEARS ONLY WHEN THERE IS GENUINELY NOTHING TO SHOW (`docs/design/states.md` §0). A
 * refresh never reaches here: the current features stay on screen with their age counting up
 * while a layer revalidates in the background (ADR 0014 §8). An indeterminate spinner on a
 * refresh keeps asserting that fresh data is arriving even after the upstream has stopped
 * answering, which is the most common way a live interface lies.
 *
 * The skeletons are `aria-hidden`. A screen reader reading out a grid of empty boxes is worse
 * than silence; the sentence above them is the announcement.
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
