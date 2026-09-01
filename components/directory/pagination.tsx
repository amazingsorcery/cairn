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
 *
 * THE UNAVAILABLE END IS DIMMED WITH A TOKEN, NEVER WITH OPACITY — audit QV-06. It used to
 * carry `opacity-40`, which rendered inherited `--foreground` at 2.63:1 in light and 3.36:1
 * in dark and failed WCAG 1.4.3 on both. WCAG's exemption for "text that is part of an
 * inactive user interface component" does not reach this markup: a `<span>` is not a user
 * interface component and cannot be disabled, so it owes the full 4.5:1 like any other text.
 * It is `--muted-foreground` instead — 7.37:1 light, 6.31:1 dark, both measured in
 * `app/tokens.css` §4.1 — and its unavailability is carried by three non-colour signals:
 * `--border` instead of `--input` on the outline, no hover fill, and no focus ring, because
 * it is not focusable. `aria-hidden` keeps it out of the accessibility tree entirely; a
 * screen reader gets the position from the "page N of M" text between the two chips.
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
