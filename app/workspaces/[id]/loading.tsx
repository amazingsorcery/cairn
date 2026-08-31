import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspaceDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading this case…
      </p>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="mt-6 h-8 w-full max-w-[36ch]" />
      <Skeleton className="mt-2 h-4 w-56" />
      <div className="mt-8 grid gap-6 xl:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-5/6" />
              <Skeleton className="h-5 w-4/6" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
