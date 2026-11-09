"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, MessageSquarePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toggleWorkspaceItem } from "@/lib/actions/workspaces";
import type { NoteView, WorkspaceItemView } from "@/lib/queries/workspaces";
import { cn } from "@/lib/utils";
import { NoteCard } from "./note-card";
import { NoteComposer } from "./note-composer";

/**
 * A case's checklist.
 *
 * Ticks are optimistic; on failure the row reverts and shows an in-row retry, keeping focus.
 * If the source playbook step is gone, the item keeps its title and tick and just loses the
 * link.
 *
 * `toggleWorkspaceItem` re-checks session and ownership server-side.
 */

export interface ChecklistProps {
  workspaceId: string;
  items: readonly WorkspaceItemView[];
  /** Notes anchored to a checklist entry, keyed by `workspaceItemId`. */
  notesByItem: Readonly<Record<string, readonly NoteView[]>>;
  /** Server-rendered note bodies, keyed by note id. See `note-card.tsx`. */
  renderedNoteBodies: Readonly<Record<string, React.ReactNode>>;
  playbookSlug: string | null;
}

function ChecklistRow({
  workspaceId,
  item,
  position,
  notes,
  renderedNoteBodies,
  playbookSlug,
}: {
  workspaceId: string;
  item: WorkspaceItemView;
  position: number;
  notes: readonly NoteView[];
  renderedNoteBodies: Readonly<Record<string, React.ReactNode>>;
  playbookSlug: string | null;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(item.checked);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);

  /**
   * The "add a note" button is replaced by the composer, so return focus to it when the
   * composer closes (otherwise focus drops to `<body>`).
   */
  const addNoteButtonRef = useRef<HTMLButtonElement>(null);
  const wasComposing = useRef(false);

  useEffect(() => {
    if (!composing && wasComposing.current) addNoteButtonRef.current?.focus();
    wasComposing.current = composing;
  }, [composing]);

  const stepHref =
    playbookSlug && item.stepOrderIndex !== null
      ? `/playbooks/${playbookSlug}#step-${item.stepOrderIndex + 1}`
      : null;

  async function apply(next: boolean) {
    const previous = checked;
    setChecked(next);
    setFailed(false);

    const result = await toggleWorkspaceItem({ id: item.id, checked: next });
    if (!result.ok) {
      // Revert so the UI matches the database.
      setChecked(previous);
      setFailed(true);
      return;
    }
    router.refresh();
  }

  const labelId = `checklist-label-${item.id}`;

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        {/* Radix renders a `button[role="checkbox"]`, which `<label for>` can't name. */}
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => void apply(value === true)}
          aria-labelledby={labelId}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          {/* Click target for mouse users; also the checkbox's accessible name. */}
          <span
            id={labelId}
            onClick={() => void apply(!checked)}
            className={cn(
              "flex cursor-pointer gap-2 text-sm leading-relaxed",
              checked ? "text-foreground-secondary" : "text-foreground",
            )}
          >
            <span className="tabular shrink-0 text-muted-foreground">{position}</span>
            <span className="min-w-0">{item.title}</span>
          </span>

          {stepHref ? (
            <Link
              href={stepHref}
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-primary underline underline-offset-4"
            >
              read this step
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          ) : null}

          {failed ? (
            <p role="status" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
              Not saved.
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => void apply(!checked)}
              >
                Retry
              </Button>
            </p>
          ) : null}

          {notes.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {notes.map((note) => (
                <li key={note.id}>
                  <NoteCard note={note} renderedBody={renderedNoteBodies[note.id]} />
                </li>
              ))}
            </ul>
          ) : null}

          {composing ? (
            <div className="mt-3">
              <NoteComposer
                workspaceId={workspaceId}
                workspaceItemId={item.id}
                label={`add a note on step ${position}`}
                placeholder="what you found, and where"
                autoFocus
                onSaved={() => setComposing(false)}
                onCancel={() => setComposing(false)}
              />
            </div>
          ) : (
            <Button
              ref={addNoteButtonRef}
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 h-11 px-2 text-xs"
              onClick={() => setComposing(true)}
            >
              <MessageSquarePlus aria-hidden="true" />
              add a note on this step
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export function Checklist({
  workspaceId,
  items,
  notesByItem,
  renderedNoteBodies,
  playbookSlug,
}: ChecklistProps) {
  if (items.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm leading-relaxed text-foreground-secondary">
          No steps yet. A checklist is copied from a playbook when the case is started, and
          this case was started without one.
        </p>
        <Button asChild variant="outline" className="mt-3 h-11">
          <Link href="/playbooks">browse playbooks</Link>
        </Button>
      </div>
    );
  }

  return (
    <ul>
      {items.map((item, index) => (
        <ChecklistRow
          key={item.id}
          workspaceId={workspaceId}
          item={item}
          position={index + 1}
          notes={notesByItem[item.id] ?? []}
          renderedNoteBodies={renderedNoteBodies}
          playbookSlug={playbookSlug}
        />
      ))}
    </ul>
  );
}
