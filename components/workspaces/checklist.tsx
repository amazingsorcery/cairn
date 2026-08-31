"use client";

import { useState } from "react";
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
 * The checklist: the spine of a case.
 *
 * TICKING IS OPTIMISTIC WITH A REAL FAILURE STATE (`docs/design/states.md` 7.3). The tick
 * applies immediately, because a checkbox that waits for a round trip feels broken. If the
 * server refuses, it REVERTS VISIBLY and says so in-row rather than leaving a tick that
 * will silently vanish on the next load — a checklist that lies about what is done is worse
 * than one that is slow. The row keeps its focus through the failure, so a keyboard user is
 * not thrown to the top of the page.
 *
 * A STEP WHOSE PLAYBOOK STEP IS GONE keeps its title, its position and its tick, and loses
 * only the link (ADR 0008, `states.md` 7.5). There is no warning colour and no icon: for a
 * long-running case this is the expected state, and a researcher opening a case after three
 * months must read it as bookkeeping, not as damage.
 *
 * The action is `toggleWorkspaceItem` from `lib/actions/workspaces.ts`, which re-checks the
 * session and re-checks ownership as a SQL predicate on `workspace_items.user_id`. This
 * component sends an id and a boolean; it does not send, and could not usefully forge, an
 * identity.
 */

export interface ChecklistProps {
  workspaceId: string;
  items: readonly WorkspaceItemView[];
  /** Notes anchored to a checklist entry, keyed by `workspaceItemId`. */
  notesByItem: Readonly<Record<string, readonly NoteView[]>>;
  playbookSlug: string | null;
}

function ChecklistRow({
  workspaceId,
  item,
  position,
  notes,
  playbookSlug,
}: {
  workspaceId: string;
  item: WorkspaceItemView;
  position: number;
  notes: readonly NoteView[];
  playbookSlug: string | null;
}) {
  const router = useRouter();
  const [checked, setChecked] = useState(item.checked);
  const [failed, setFailed] = useState(false);
  const [composing, setComposing] = useState(false);

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
      // Revert visibly. The alternative is a tick the reader trusts and the database
      // does not have.
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
        {/*
          `aria-labelledby`, NOT a `<label htmlFor>`. Radix renders the checkbox as a
          `button[role="checkbox"]`, and a `<label for>` gives an accessible name only to a
          labelable element — so the pairing that looks right leaves the control announced
          as an unnamed checkbox. Caught in the accessibility tree, not by reading the code.
        */}
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => void apply(value === true)}
          aria-labelledby={labelId}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          {/*
            A span with a pointer handler, not a label: it is a redundant affordance for
            mouse users, and the checkbox above is the keyboard path. `aria-hidden` is not
            set because this element IS the checkbox's accessible name.
          */}
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
                  <NoteCard note={note} />
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
                onSaved={() => setComposing(false)}
              />
            </div>
          ) : (
            <Button
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

export function Checklist({ workspaceId, items, notesByItem, playbookSlug }: ChecklistProps) {
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
          playbookSlug={playbookSlug}
        />
      ))}
    </ul>
  );
}
