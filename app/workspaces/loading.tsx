import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspacesLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading your cases…
      </p>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-4 h-6 w-full max-w-[52ch]" />
      <div className="mt-8 flex flex-col gap-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card p-5">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="mt-3 h-4 w-56" />
            <Skeleton className="mt-3 h-4 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
