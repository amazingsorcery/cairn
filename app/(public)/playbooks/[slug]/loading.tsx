import { Skeleton } from "@/components/ui/skeleton";

/**
 * First paint for `/playbooks/[slug]`.
 *
 * The skeleton reserves the confidence chip and the last-verified line, because neither is
 * optional anywhere in this product (`docs/design/states.md` §0) and omitting them here
 * would shift the layout the moment the real header arrives.
 */
export default function PlaybookDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <p aria-live="polite" className="sr-only">
        Loading this playbook…
      </p>

      <Skeleton className="h-4 w-64" />

      <div className="mt-6 md:grid md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:gap-10">
        <div className="md:col-start-2 md:row-start-1">
          <Skeleton className="h-9 w-full max-w-[36ch]" />
          <Skeleton className="mt-4 h-6 w-full max-w-[52ch]" />
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-4 h-5 w-32 rounded-full" />
          <Skeleton className="mt-2 h-4 w-56" />
          <Skeleton className="mt-6 h-11 w-full sm:w-72" />
        </div>

        <div className="mt-8 md:col-start-1 md:row-span-2 md:row-start-1 md:mt-0">
          <Skeleton className="h-64 w-full" />
        </div>

        <div className="md:col-start-2 md:row-start-2">
          <div className="mt-10 flex flex-col gap-10">
            {[0, 1, 2].map((index) => (
              <div key={index}>
                <Skeleton className="h-7 w-full max-w-[32ch]" />
                <Skeleton className="mt-5 h-4 w-24" />
                <Skeleton className="mt-2 h-5 w-full max-w-[60ch]" />
                <Skeleton className="mt-5 h-4 w-full max-w-[64ch]" />
                <Skeleton className="mt-1.5 h-4 w-full max-w-[58ch]" />
                <Skeleton className="mt-6 h-24 w-full max-w-[68ch]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
