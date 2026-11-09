import Link from "next/link";
import { ShieldOff } from "lucide-react";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { isInsecureUrl } from "@/lib/content/schema";
import type { ToolCard as ToolCardData } from "@/lib/queries/tools";
import { cn, displayHost } from "@/lib/utils";

import { costLabel, typeLabel } from "./facets";

/**
 * One catalogue entry in a list.
 *
 * The footer (confidence chip, last-verified) is pinned with `h-full` + `flex-col` +
 * `mt-auto` so it aligns across a row. Plain-HTTP URLs get a badge.
 *
 * Only the name is a link; a card-wide link would swallow the chip's `/methodology` link.
 */

export function ToolCard({ tool, className }: { tool: ToolCardData; className?: string }) {
  const insecure = isInsecureUrl(tool.url);

  return (
    <article
      className={cn(
        "flex h-full flex-col rounded-lg border border-border bg-card p-4",
        "transition-colors hover:border-foreground-faint motion-reduce:transition-none",
        className,
      )}
    >
      <h3 className="text-base font-semibold tracking-tight">
        <Link
          href={`/tools/${tool.slug}`}
          className={cn(
            "rounded-sm underline-offset-4 hover:underline",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          {tool.name}
        </Link>
      </h3>

      <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={tool.url}>
        {displayHost(tool.url)}
      </p>

      <p className="mt-3 text-sm leading-relaxed text-foreground-secondary">{tool.summary}</p>

      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Entry facts">
        <li>
          <Badge variant="muted">{costLabel(tool.costModel)}</Badge>
        </li>
        {tool.jurisdiction ? (
          <li>
            <Badge variant="muted">{tool.jurisdiction}</Badge>
          </li>
        ) : null}
        {tool.inputTypes.slice(0, 2).map((value) => (
          <li key={`in-${value}`}>
            <Badge variant="outline" className="font-mono">
              {typeLabel(value)}
            </Badge>
          </li>
        ))}
      </ul>

      {insecure ? (
        <p className="mt-3 inline-flex items-start gap-1.5 text-xs text-warning">
          <ShieldOff className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>Served over http://, not https://</span>
        </p>
      ) : null}

      {/* Pinned footer. */}
      <div className="mt-auto flex flex-col gap-1.5 pt-4">
        <ConfidenceChipLink level={tool.confidence} className="self-start" />
        <VerificationDate lastVerifiedAt={tool.lastVerifiedAt} className="tabular" />
      </div>
    </article>
  );
}

/**
 * Loading placeholder. Reserves space for the chip and last-verified line so the layout
 * doesn't jump. `aria-hidden` via `Skeleton`; the route's live region announces loading.
 */
export function ToolCardSkeleton() {
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-4">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="mt-2 h-3.5 w-1/3" />
      <Skeleton className="mt-4 h-4 w-full" />
      <Skeleton className="mt-1.5 h-4 w-5/6" />
      <div className="mt-3 flex gap-1.5">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-10 rounded-full" />
      </div>
      <div className="mt-auto flex flex-col gap-1.5 pt-4">
        <Skeleton className="h-6 w-32 rounded-full" />
        <Skeleton className="h-4 w-44" />
      </div>
    </div>
  );
}

/** 1/2/3-column grid. `items-stretch` lets the card's `h-full` work. */
export function ToolGrid({ children }: { children: React.ReactNode }) {
  return (
    <ul className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
      {children}
    </ul>
  );
}

export function ToolGridSkeleton({ count }: { count: number }) {
  return (
    <div
      className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3"
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => (
        <ToolCardSkeleton key={index} />
      ))}
    </div>
  );
}
