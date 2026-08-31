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
 * One catalogue entry, as it appears in every list.
 *
 * THE CARD FOOTER IS PINNED. `docs/design/wireframes/02-directory.txt`: the confidence chip
 * and the last-verified line sit at the bottom of every card so they align across a row and
 * can be scanned down a column. ADR 0007 calls that a design constraint rather than a
 * preference — the whole grid exists so a reader can compare *our certainty* across entries
 * at a glance, and a footer that floats up and down with the summary length defeats it.
 * `h-full` + `flex-col` + `mt-auto` is what holds it.
 *
 * Architecture HANDOFF §9.1: `confidence` and `lastVerifiedAt` render everywhere an entry
 * appears. There is no compact variant of this card that drops them.
 *
 * §9.7: a plain-HTTP catalogue link is badged here as well as on the detail page. It is
 * detected from the stored URL scheme; there is no column for it and none is needed.
 *
 * The whole card is not a link. The name is. A card-wide click target swallows the
 * confidence chip's link to `/methodology`, which is the one link on the card that must
 * always be reachable.
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

      {/* Pinned footer — see the note above. */}
      <div className="mt-auto flex flex-col gap-1.5 pt-4">
        <ConfidenceChipLink level={tool.confidence} className="self-start" />
        <VerificationDate lastVerifiedAt={tool.lastVerifiedAt} className="tabular" />
      </div>
    </article>
  );
}

/**
 * The loading placeholder. `states.md` §2.3 requires it to reserve the confidence chip and
 * the last-verified line, so the layout does not jump when the real card arrives — and so
 * that a reader never sees a card that briefly appears to have no confidence value.
 *
 * `aria-hidden` via `Skeleton`; the accessible signal is the one `aria-live` region on the
 * route (shell handoff §10.1).
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

/**
 * The grid. One column at 375px, two at `md:`, three at `xl:` —
 * `docs/design/wireframes/00-conventions.txt`. `items-stretch` is what lets `h-full` on the
 * card do its job.
 */
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
