"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VerificationDate } from "@/components/verification-date";
import { removeWorkspaceItem } from "@/lib/actions/workspaces";
import type { WorkspaceItemView } from "@/lib/queries/workspaces";
import { formatDate } from "@/lib/utils";
import { isoDate } from "./dates";
import type { ToolFacts } from "./tool-facts-types";

/**
 * Tools saved into a case.
 *
 * Live entries show a link, confidence chip and last-verified date. If the tool was deleted
 * or unpublished, `toolSlug` is null and the saved `title` snapshot renders as plain text,
 * without warning styling (expected in long-running cases).
 *
 * Removal is a hard delete, so it asks for confirmation.
 */

export interface SavedToolsProps {
  items: readonly WorkspaceItemView[];
  /** Catalogue facts for the entries that still resolve, keyed by slug. */
  facts: Readonly<Record<string, ToolFacts>>;
}

function RemoveButton({ item }: { item: WorkspaceItemView }) {
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
        <DialogContent closeLabel="keep this entry">
          <DialogHeader>
            <DialogTitle>Remove this from the case?</DialogTitle>
            <DialogDescription>
              {item.title} will be taken off this case. Your notes stay where they are. This
              cannot be undone, but you can save the entry again from the directory.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="status" className="text-sm text-destructive">
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

export function SavedTools({ items, facts }: SavedToolsProps) {
  if (items.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm leading-relaxed text-foreground-secondary">
          No tools saved here. Save one from any directory entry.
        </p>
        <Button asChild variant="outline" className="mt-3 h-11">
          <Link href="/directory">browse the directory</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul>
      {items.map((item) => {
        const fact = item.toolSlug ? facts[item.toolSlug] : undefined;
        const savedIso = isoDate(item.createdAt);

        return (
          <li key={item.id} className="border-b border-border px-4 py-3 last:border-b-0">
            {item.toolSlug && fact ? (
              <>
                <Link
                  href={`/tools/${item.toolSlug}`}
                  className="rounded-sm text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.title}
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ConfidenceChipLink level={fact.confidence} showMeter={false} />
                  <VerificationDate lastVerifiedAt={fact.lastVerifiedAt} className="text-xs" />
                </div>
              </>
            ) : (
              // Removed from the catalogue: plain text, no alarm.
              <div className="text-foreground-secondary">
                <p className="text-sm">
                  {item.title} — no longer in the catalogue
                </p>
                <p className="mt-1 text-xs leading-relaxed">
                  Saved on <time dateTime={savedIso}>{formatDate(item.createdAt)}</time>. This
                  entry has since been removed, so there&rsquo;s no page to link to. Your note
                  and your tick are untouched.
                </p>
              </div>
            )}

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              {item.toolSlug && fact ? (
                <p className="tabular text-xs text-muted-foreground">
                  saved <time dateTime={savedIso}>{formatDate(item.createdAt)}</time>
                </p>
              ) : (
                <span />
              )}
              <RemoveButton item={item} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
