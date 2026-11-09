import { Loader2 } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * First load of `/live/flights` only. Refreshes keep the current data on screen with its age
 * while revalidating in the background.
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
