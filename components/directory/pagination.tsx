import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Explicit pages, never infinite scroll.
 *
 * An investigator has to be able to get back to where they were — to reopen the third card
 * on page 4 tomorrow, and to paste that page into a note. Infinite scroll has no address for
 * "where they were", and it also breaks the browser's own back button, which is the control
 * this whole route is built around (`wireframes/02-directory.txt`).
 *
 * Both controls are links, so they are middle-clickable, keyboard-operable and prefetched by
 * `next/link` without any JavaScript of ours. The unavailable end renders as disabled text
 * rather than a link to nowhere.
 */
export function Pagination({
  page,
  pageCount,
  hrefForPage,
  className,
}: {
  page: number;
  pageCount: number;
  hrefForPage: (page: number) => string;
  className?: string;
}) {
  if (pageCount <= 1) return null;

  const hasPrev = page > 1;
  const hasNext = page < pageCount;

  const shape = cn(
    "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input px-3 text-sm",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  );

  return (
    <nav aria-label="Directory pages" className={cn("flex items-center justify-between gap-3", className)}>
      {hasPrev ? (
        <Link href={hrefForPage(page - 1)} rel="prev" className={cn(shape, "hover:bg-accent")}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          prev
        </Link>
      ) : (
        <span className={cn(shape, "cursor-default opacity-40")} aria-hidden="true">
          <ChevronLeft className="size-4" />
          prev
        </span>
      )}

      <p className="tabular text-sm text-muted-foreground">
        page {page} of {pageCount}
      </p>

      {hasNext ? (
        <Link href={hrefForPage(page + 1)} rel="next" className={cn(shape, "hover:bg-accent")}>
          next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : (
        <span className={cn(shape, "cursor-default opacity-40")} aria-hidden="true">
          next
          <ChevronRight className="size-4" />
        </span>
      )}
    </nav>
  );
}
