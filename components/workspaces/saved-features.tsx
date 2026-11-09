"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { removeWorkspaceItem } from "@/lib/actions/workspaces";
import type { WorkspaceFeatureView } from "@/lib/queries/workspaces";
import { formatTimestamp } from "@/lib/utils";
import { isoTimestamp } from "./dates";

/**
 * Live map features saved into a case. Each row is a snapshot; upstream sources keep no
 * history, so there is nothing live behind it.
 *
 * - Shows both the upstream observed time and our saved time.
 * - Attribution (ODbL, CC BY, TfL terms) is stored on the row and rendered with it, so it
 *   survives a connector being retired.
 * - Any precision caveat sits directly under the coordinate.
 *
 * Removal is a hard delete via the same action as `saved-tools.tsx`.
 */

export interface SavedFeaturesProps {
  items: readonly WorkspaceFeatureView[];
}

function RemoveButton({ item }: { item: WorkspaceFeatureView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);
    const result = await removeWorkspaceItem({ id: item.id });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-11 text-xs"
        onClick={() => setOpen(true)}
      >
        remove from this case
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel="keep this feature">
          <DialogHeader>
            <DialogTitle>Remove this from the case?</DialogTitle>
            <DialogDescription>
              {item.title} will be taken off this case, and this copy is the only one — the
              source keeps no history, so it cannot be saved again. Your notes stay where they
              are. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="status" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" autoFocus onClick={() => setOpen(false)}>
              cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void remove()}>
              remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SavedFeatures({ items }: SavedFeaturesProps) {
  if (items.length === 0) {
    return (
      <div className="p-4">
        <p className="text-foreground-secondary text-sm leading-relaxed">
          Nothing saved from the map here. Open a feature on the map and save it — what you keep
          is a copy, because the sources keep no history.
        </p>
        <Button asChild variant="outline" className="mt-3 h-11">
          <Link href="/map">open the map</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul>
      {items.map((item) => {
        const observedIso = isoTimestamp(item.observedAt);
        const savedIso = isoTimestamp(item.savedAt);

        return (
          <li key={item.id} className="border-border border-b px-4 py-3 last:border-b-0">
            <p className="text-sm font-medium">{item.title}</p>

            <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">Observed</dt>
                <dd className="tabular text-xs">
                  <time dateTime={observedIso}>{formatTimestamp(item.observedAt)}</time>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">Saved</dt>
                <dd className="tabular text-xs">
                  <time dateTime={savedIso}>{formatTimestamp(item.savedAt)}</time>
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">Position</dt>
                <dd className="tabular font-mono text-xs">
                  {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}
                  {item.altitudeMetres === null
                    ? null
                    : ` · ${Math.round(item.altitudeMetres)} m`}
                </dd>
                {item.precision ? (
                  <p className="text-foreground-secondary mt-1 text-xs leading-relaxed">
                    <span className="text-foreground font-semibold">Approximate position.</span>{" "}
                    {item.precision.note}
                  </p>
                ) : null}
              </div>
            </dl>

            {item.sourceUrl ? (
              <p className="mt-2">
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 text-xs underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                  the record at {item.sourceName}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            ) : null}

            {/* Attribution as captured at save time, not joined from `connectors`. */}
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {item.sourceName} · {item.attribution} · {item.licence}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2">
              <RemoveButton item={item} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
