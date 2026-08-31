"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One of the three regions of a case: checklist, saved tools, notes.
 *
 * At 375px they stack in that order and each collapses with its count in the header, so the
 * whole case is reachable without scrolling past two full regions to find the third
 * (`docs/design/states.md` §7.2). From `md` up all three are open at once — the value of
 * this page is having the case in front of you.
 *
 * The collapse uses the `hidden` attribute plus `md:block`. An author-level `display` beats
 * the user-agent `[hidden]` rule, so the content is always visible from `md` up regardless
 * of the collapsed state, and the toggle that could otherwise strand it is `md:hidden`.
 */
export function Region({
  title,
  count,
  countLabel,
  action,
  children,
}: {
  title: string;
  /** Rendered `.tabular` beside the heading. A string so "4/9" and "7" both work. */
  count: string;
  /** What the count means, for a screen reader. */
  countLabel: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2
          id={headingId}
          className="flex items-baseline gap-3 text-sm font-semibold uppercase tracking-wide text-foreground-secondary"
        >
          {title}
          <span className="tabular text-sm font-normal normal-case tracking-normal text-foreground">
            <span className="sr-only">{countLabel}: </span>
            {count}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          {action}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                open ? "rotate-180" : "rotate-0",
              )}
              aria-hidden="true"
            />
            <span className="sr-only">
              {open ? `collapse ${title}` : `expand ${title}`}
            </span>
          </button>
        </div>
      </div>
      <div id={bodyId} hidden={!open} className="md:block">
        {children}
      </div>
    </section>
  );
}
