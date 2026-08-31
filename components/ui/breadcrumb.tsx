import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Breadcrumb trail.
 *
 * The directory nests three deep (`/directory` → category → tool) and playbook steps are
 * deep-linked, so a reader arriving from search needs to know where they landed. That is
 * the whole job: orientation for someone who did not navigate here.
 *
 * Accessibility notes that are easy to get wrong and are the reason this is a component
 * rather than ad-hoc markup:
 *   - The list lives in a `<nav aria-label="Breadcrumb">` so it is reachable as a landmark
 *     and distinguishable from the primary nav.
 *   - The current page is a plain element with `aria-current="page"`, not a link. A link to
 *     the page you are already on is noise for keyboard and screen-reader users.
 *   - The separators are `aria-hidden`; a screen reader announcing "chevron right" between
 *     every crumb is worse than silence, and the list structure already conveys the nesting.
 */

export interface Crumb {
  label: string;
  /** Omit on the final crumb — the current page is not a link. */
  href?: string;
}

export interface BreadcrumbProps {
  items: readonly Crumb[];
  className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? (
                <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
              ) : null}
              {isLast || !item.href ? (
                <span aria-current={isLast ? "page" : undefined} className="truncate text-foreground">
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className={cn(
                    "truncate rounded-sm underline-offset-4 hover:text-foreground hover:underline",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
