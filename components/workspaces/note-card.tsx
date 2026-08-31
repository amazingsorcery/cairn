"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Markdown } from "@/components/content/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { deleteNote, updateNote } from "@/lib/actions/workspaces";
import type { NoteView } from "@/lib/queries/workspaces";
import { formatTimestamp } from "@/lib/utils";
import { isoTimestamp } from "./dates";
import { SaveIndicator, type SaveState } from "./save-indicator";
import { useUnsavedGuard } from "./use-unsaved-guard";

/**
 * One timestamped note, and the single most important behaviour in this half of the
 * product: THE TEXT IN THIS BOX MUST NOT BE LOSABLE.
 *
 * `docs/design/flows.md` W1 and M1/M2 are implemented here, in this order:
 *
 *  1. AUTOSAVE ON PAUSE. An edit saves 800 ms after typing stops, and immediately on blur.
 *     The 800 ms is from M1 and is not a guess to be retuned casually: it is long enough
 *     that a normal typing rhythm does not fire it on every word, and short enough that
 *     nothing more than a sentence is ever at risk.
 *  2. `beforeunload` WHILE DIRTY. The browser's own dialog is the only thing that reliably
 *     survives a tab close, which is why it is used rather than a prettier one that does
 *     not fire. It is disarmed the moment a save lands, so it never cries wolf.
 *  3. ON FAILURE THE TEXT STAYS IN THE FIELD, the guard stays armed, and the retry is a
 *     real button. Nothing is silently discarded and nothing is silently retried forever.
 *  4. NOTHING IS WRITTEN TO `localStorage`. A case note in browser storage on a shared
 *     machine is a threat-model failure for this audience (`states.md` 7.4). The guard is
 *     the mitigation; local persistence is not on the table.
 *
 * THE EDITOR IS NEVER INSIDE A DIALOG. Escape closes a Radix dialog and Escape is a normal
 * key to press while typing (`states.md` 7.4). The delete confirmation is a dialog; the
 * composer and the editor are not.
 *
 * `created_at` is never rewritten by `updateNote` — it is the "timestamped" in "timestamped
 * notes", and an investigator's record of when they wrote something has to be stable.
 */

const AUTOSAVE_DELAY_MS = 800;

export interface NoteCardProps {
  note: NoteView;
  /** What this note is attached to, if anything, so a note is never orphaned in the UI. */
  anchorLabel?: string | undefined;
}

export function NoteCard({ note, anchorLabel }: NoteCardProps) {
  const router = useRouter();
  const editorId = useId();

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [saved, setSaved] = useState(note.body);
  const [state, setState] = useState<SaveState>({ status: "clean" });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const dirty = body.trim() !== saved.trim() && body.trim() !== "";
  useUnsavedGuard(dirty);

  const save = useCallback(
    async (next: string) => {
      const candidate = next.trim();
      if (candidate === "" || candidate === saved.trim() || inFlight.current) return;
      inFlight.current = true;
      setState({ status: "saving" });

      const result = await updateNote({ id: note.id, body: candidate });
      inFlight.current = false;

      if (!result.ok) {
        setState({
          status: "failed",
          message:
            result.code === "unauthenticated"
              ? "you were signed out. Sign back in — your text is still here."
              : result.message,
        });
        return;
      }

      setSaved(candidate);
      setState({ status: "saved", at: new Date() });
      router.refresh();
    },
    [note.id, saved, router],
  );

  // Autosave on pause. The timer is cleared on every keystroke so it fires once, when
  // typing stops, rather than once per character.
  useEffect(() => {
    if (!editing || !dirty) return;
    setState((current) => (current.status === "failed" ? current : { status: "dirty" }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(body), AUTOSAVE_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body, dirty, editing, save]);

  async function onDelete() {
    setDeleteError(null);
    const result = await deleteNote({ id: note.id });
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setConfirmingDelete(false);
    router.refresh();
  }

  const iso = isoTimestamp(note.createdAt);

  return (
    <article className="rounded-md border border-border bg-background p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="tabular text-xs text-muted-foreground">
          <time dateTime={iso}>{formatTimestamp(note.createdAt)}</time>
        </h4>
        {anchorLabel ? <p className="text-xs text-muted-foreground">on {anchorLabel}</p> : null}
      </header>

      {editing ? (
        <>
          <label htmlFor={editorId} className="sr-only">
            edit this note
          </label>
          <Textarea
            id={editorId}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onBlur={() => {
              if (timer.current) clearTimeout(timer.current);
              void save(body);
            }}
            className="mt-2 min-h-32 font-mono text-sm"
          />
        </>
      ) : (
        <div className="mt-2">
          <Markdown className="text-sm">{saved}</Markdown>
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <SaveIndicator state={state} onRetry={() => void save(body)} />
        <div className="flex items-center gap-1">
          {editing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11"
              onClick={() => {
                if (timer.current) clearTimeout(timer.current);
                void save(body).then(() => setEditing(false));
              }}
            >
              done
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11"
              onClick={() => setEditing(true)}
            >
              edit
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 text-destructive hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            delete
          </Button>
        </div>
      </footer>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent closeLabel="keep this note">
          <DialogHeader>
            <DialogTitle>Delete this note?</DialogTitle>
            <DialogDescription>
              Written {formatTimestamp(note.createdAt)}. This cannot be undone and the text is
              not recoverable.
            </DialogDescription>
          </DialogHeader>
          <p className="max-h-32 overflow-y-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">
            {saved}
          </p>
          {deleteError ? (
            <p role="status" className="mt-3 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            {/* Cancel carries initial focus: the destructive control is never the default. */}
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setConfirmingDelete(false)}
            >
              cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void onDelete()}>
              delete this note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
