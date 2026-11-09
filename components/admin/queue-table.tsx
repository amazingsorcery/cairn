import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import type { QueueEntry } from "@/lib/queries/admin";

/**
 * One list in the verification queue.
 *
 * Order comes from the database (`confidence`, then `last_verified_at ASC NULLS FIRST`) and
 * is the editorial priority, so there's no client-side sort. Uses the same public confidence
 * chip and verification line readers see.
 *
 * No bulk "confirm all": each confirmation is per entry. `reverifyTools` is intentionally
 * not wired up here.
 */

export interface QueueTableProps {
  caption: string;
  entries: readonly QueueEntry[];
  /** The row control. Built by the page, which owns the choice of Server Action. */
  renderAction: (entry: QueueEntry) => React.ReactNode;
  /** Connectors have no `confidence`; the column is dropped rather than left blank. */
  showConfidence?: boolean;
  /** Header for the date column — "last verified" for content, "terms last read" for a connector. */
  dateHeading?: string;
}

export function QueueTable({
  caption,
  entries,
  renderAction,
  showConfidence = true,
  dateHeading = "last verified",
}: QueueTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              name
            </th>
            <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              status
            </th>
            {showConfidence ? (
              <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                confidence
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              {dateHeading}
            </th>
            <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
              action
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.kind}-${entry.id}`} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-3 text-left font-medium">
                {entry.title}
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {entry.slug}
                </span>
              </th>
              <td className="px-3 py-3">
                {entry.status === "published" ? (
                  <Badge variant="success">published</Badge>
                ) : (
                  <Badge variant="muted">draft</Badge>
                )}
              </td>
              {showConfidence ? (
                <td className="px-3 py-3">
                  {entry.confidence ? <ConfidenceChipLink level={entry.confidence} showMeter={false} /> : null}
                </td>
              ) : null}
              <td className="px-3 py-3">
                <VerificationDate lastVerifiedAt={entry.lastVerifiedAt} />
              </td>
              <td className="px-3 py-3">{renderAction(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
