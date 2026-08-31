"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ListOrdered } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Step navigation for `/playbooks/[slug]`.
 *
 * ALL STEPS ARE ON ONE PAGE (wireframe 06). Not a wizard, not one step per route: a method
 * is read end to end before it is followed, and a reader on a deadline needs Ctrl+F to
 * work. This component therefore never fetches and never changes the route — it moves
 * within the page.
 *
 * WHY THE LINKS ARE PLAIN ANCHORS. `#step-3` is the whole contract: deep-linkable,
 * shareable, keyboard operable with no JavaScript at all, and restorable by the browser's
 * own back button. `app/globals.css` sets `scroll-padding-top: 5rem` so the target never
 * lands under the sticky header, and each step heading carries `tabIndex={-1}` so following
 * the anchor also moves focus there rather than leaving it in the nav.
 *
 * The active marker is a READING POSITION, not a completion state (wireframe 06 notes).
 * Nothing is ticked on a public page — progress belongs to a case, not to a shared URL.
 *
 * THE MOBILE COLLAPSE IS CLASS-DRIVEN, NOT THE `hidden` ATTRIBUTE. Measured in the browser,
 * `hidden` plus `md:block` left the list `display: none` at 1280px while its toggle was
 * `md:hidden` — collapse on a phone, widen the window, and the step index is gone with no
 * way back. Two Tailwind utilities in one layer do not fight: `md:block` is emitted after
 * `hidden` and wins from `md` up.
 */

export interface StepNavigatorProps {
  steps: readonly { anchor: string; title: string }[];
}

export function StepNavigator({ steps }: StepNavigatorProps) {
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (steps.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;

    const headings = steps
      .map((step, index) => {
        const element = document.getElementById(step.anchor);
        return element ? { element, index } : null;
      })
      .filter((entry): entry is { element: HTMLElement; index: number } => entry !== null);

    if (headings.length === 0) return;

    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const match = headings.find((h) => h.element === entry.target);
          if (!match) continue;
          if (entry.isIntersecting) visible.add(match.index);
          else visible.delete(match.index);
        }
        if (visible.size > 0) setActiveIndex(Math.min(...visible));
      },
      // The band starts below the sticky header and ends most of the way down the
      // viewport, so "in view" means "the reader is looking at it", not "it grazed the
      // bottom edge".
      //
      // `rootMargin` MUST be px or %. A rem value throws a SyntaxError at construction
      // time, which the error boundary then catches as a whole-page failure — 80px is the
      // `scroll-padding-top: 5rem` from `app/globals.css` at the default root font size.
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (const { element } of headings) observer.observe(element);
    return () => observer.disconnect();
  }, [steps]);

  if (steps.length === 0) return null;

  const previous = activeIndex > 0 ? steps[activeIndex - 1] : undefined;
  const next = activeIndex < steps.length - 1 ? steps[activeIndex + 1] : undefined;

  return (
    <>
      <nav aria-label="Steps" className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-foreground-secondary">
            <ListOrdered className="size-4" aria-hidden="true" />
            Steps
          </h2>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
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
            <span className="sr-only">{open ? "collapse the step index" : "expand the step index"}</span>
          </button>
        </div>

        <ol id={listId} className={cn(open ? "block" : "hidden", "md:block border-t border-border py-1")}>
          {steps.map((step, index) => {
            const isActive = index === activeIndex;
            return (
              <li key={step.anchor}>
                <a
                  href={`#${step.anchor}`}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "flex min-h-11 items-start gap-3 px-4 py-2.5 text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    isActive
                      ? "font-semibold text-foreground"
                      : "text-foreground-secondary hover:text-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "tabular mt-px w-5 shrink-0 text-right",
                      isActive ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="sr-only">step {index + 1}: </span>
                    {step.title}
                    {isActive ? <span className="sr-only"> — currently in view</span> : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      </nav>

      {/*
        The mobile position bar. It reports which step heading is currently in view, so it
        is honest about position without being a navigation state the reader has to
        maintain. Hidden from `md` up, where the rail already does this job.
      */}
      <div className="sticky bottom-0 z-[var(--z-sticky)] -mx-4 mt-8 flex items-center justify-between gap-2 border-t border-border bg-background/95 px-4 py-2 backdrop-blur md:hidden">
        {previous ? (
          <a
            href={`#${previous.anchor}`}
            className="inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            previous
            <span className="sr-only"> step: {previous.title}</span>
          </a>
        ) : (
          <span className="inline-flex h-11 items-center px-3 text-sm text-muted-foreground">
            first step
          </span>
        )}

        <p className="tabular text-sm text-foreground-secondary">
          step {activeIndex + 1} of {steps.length}
        </p>

        {next ? (
          <a
            href={`#${next.anchor}`}
            className="inline-flex h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            next
            <span className="sr-only"> step: {next.title}</span>
            <ChevronRight className="size-4" aria-hidden="true" />
          </a>
        ) : (
          <span className="inline-flex h-11 items-center px-3 text-sm text-muted-foreground">
            last step
          </span>
        )}
      </div>
    </>
  );
}
