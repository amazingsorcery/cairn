import Link from "next/link";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Skeleton } from "@/components/ui/skeleton";
import type { PlaybookHit, ToolHit } from "@/lib/queries/search";
import { cn } from "@/lib/utils";

/**
 * A search result row.
 *
 * Architecture HANDOFF §9.1: `confidence` and `lastVerifiedAt` render **everywhere an entry
 * appears**, and a search result row is named in that list explicitly. There is no compact
 * search variant that drops them — `wireframes/04-search.txt`: "same chip, same rules, no
 * exceptions".
 *
 * `confidence` is not a ranking input (ADR 0007 §6): down-ranking `needsReview` would bury
 * exactly the entries a reader most needs to approach sceptically, and would quietly turn a
 * transparency field into an editorial filter. The ordering here is whatever `search()`
 * returned; this file only renders it.
 */

function Row({
  href,
  title,
  summary,
  footer,
}: {
  href: string;
  title: string;
  summary: string;
  footer: React.ReactNode;
}) {
  return (
    <li>
      <article className="flex h-full flex-col rounded-lg border border-border bg-card p-4">
        <h3 className="text-base font-semibold tracking-tight">
          <Link
            href={href}
            className={cn(
              "rounded-sm underline-offset-4 hover:underline",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            {title}
          </Link>
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">{summary}</p>
        <div className="mt-auto flex flex-col gap-1.5 pt-4">{footer}</div>
      </article>
    </li>
  );
}

export function ToolHitRow({ hit }: { hit: ToolHit }) {
  return (
    <Row
      href={`/tools/${hit.slug}`}
      title={hit.name}
      summary={hit.summary}
      footer={
        <>
          <ConfidenceChipLink level={hit.confidence} className="self-start" />
          <VerificationDate lastVerifiedAt={hit.lastVerifiedAt} className="tabular" />
        </>
      }
    />
  );
}

export function PlaybookHitRow({ hit }: { hit: PlaybookHit }) {
  return (
    <Row
      href={`/playbooks/${hit.slug}`}
      title={hit.title}
      summary={hit.summary}
      footer={
        <>
          <ConfidenceChipLink level={hit.confidence} className="self-start" />
          <VerificationDate lastVerifiedAt={hit.lastVerifiedAt} className="tabular" />
        </>
      }
    />
  );
}

export function ResultList({ children }: { children: React.ReactNode }) {
  return <ul className="grid grid-cols-1 items-stretch gap-4">{children}</ul>;
}

export function SearchSkeleton({ count }: { count: number }) {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-1.5 h-4 w-4/5" />
          {/* Reserved: the chip and the last-verified line are never optional. */}
          <Skeleton className="mt-4 h-6 w-32 rounded-full" />
          <Skeleton className="mt-1.5 h-4 w-44" />
        </div>
      ))}
    </div>
  );
}
