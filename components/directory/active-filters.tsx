import Link from "next/link";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ActiveFilter } from "./filter-url";

/**
 * Removable filter chips. Each is a link with one filter dropped, so removal is one click
 * and the back button works. The whole 44px chip is the hit area, not just the `×`.
 */
export function ActiveFilterChips({
  filters,
  hrefFor,
  clearHref,
  className,
}: {
  filters: readonly ActiveFilter[];
  hrefFor: (filter: ActiveFilter) => string;
  clearHref: string;
  className?: string;
}) {
  if (filters.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <h2 className="sr-only">Active filters</h2>
      <ul className="flex flex-wrap items-center gap-2">
        {filters.map((filter) => (
          <li key={filter.id}>
            <Link
              href={hrefFor(filter)}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border border-border",
                "bg-muted px-3 text-sm text-foreground",
                "hover:border-foreground-faint hover:bg-accent hover:text-accent-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
            >
              <span>{filter.label}</span>
              <X className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
              <span className="sr-only">— remove this filter</span>
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href={clearHref}
        className={cn(
          "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary",
          "underline-offset-4 hover:underline",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        clear all
      </Link>
    </div>
  );
}
