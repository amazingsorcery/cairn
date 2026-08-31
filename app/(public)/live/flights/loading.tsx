import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * The first load of `/live/flights` — one of exactly two spinners in this product
 * (`docs/design/states.md` §0), and it carries text saying what is happening.
 *
 * IT APPEARS ONLY WHEN THERE IS GENUINELY NOTHING TO SHOW. A refresh never reaches here: the
 * current data stays on screen with its age counting up while revalidation happens in the
 * background (ADR 0014 §8). An indeterminate spinner on a refresh keeps asserting that fresh
 * data is arriving even after the upstream has stopped answering, which is the most common
 * way a live interface lies.
 */
export default function LoadingFlights() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="flex items-center gap-2 text-sm text-foreground-secondary">
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <p aria-live="polite">Loading aircraft positions…</p>
      </div>
      <div className="mt-6 space-y-4" aria-hidden="true">
        <Skeleton className="h-11 w-full max-w-md" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
