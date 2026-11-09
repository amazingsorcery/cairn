import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Prev/next page links (no infinite scroll, so every page has a shareable URL and the back
 * button works).
 *
 * The unavailable end is a span using `--muted-foreground`, not opacity, so it still meets
 * WCAG 4.5:1 contrast. It's `aria-hidden`; "page N of M" carries the position.
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

  const shape = "inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm";

  const available = cn(
    shape,
    "border-input hover:bg-accent",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  );

  const unavailable = cn(shape, "cursor-default border-border text-muted-foreground");

  return (
    <nav aria-label="Directory pages" className={cn("flex items-center justify-between gap-3", className)}>
      {hasPrev ? (
        <Link href={hrefForPage(page - 1)} rel="prev" className={available}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          prev
        </Link>
      ) : (
        <span className={unavailable} aria-hidden="true">
          <ChevronLeft className="size-4" />
          prev
        </span>
      )}

      <p className="tabular text-sm text-muted-foreground">
        page {page} of {pageCount}
      </p>

      {hasNext ? (
        <Link href={hrefForPage(page + 1)} rel="next" className={available}>
          next
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : (
        <span className={unavailable} aria-hidden="true">
          next
          <ChevronRight className="size-4" />
        </span>
      )}
    </nav>
  );
}
