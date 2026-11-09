"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ListOrdered } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Step navigation for `/playbooks/[slug]`. All steps are on one page (so Ctrl+F works);
 * links are plain `#step-N` anchors, and headings take focus via `tabIndex={-1}`. The
 * active marker is reading position, not completion.
 *
 * The mobile collapse uses classes, not the `hidden` attribute, which would stay hidden
 * at `md` and up after collapsing.
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
      // Band from below the sticky header to 40% down the viewport. `rootMargin` must be
      // px or % (rem throws); 80px matches `scroll-padding-top: 5rem`.
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

      {/* Mobile position bar showing the step in view; the rail covers this from `md` up. */}
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
