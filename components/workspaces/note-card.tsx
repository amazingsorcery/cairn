"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
 * One timestamped note with inline editing.
 *
 * - Autosaves 800 ms after typing stops, and on blur.
 * - `beforeunload` guard while dirty; on failure the text stays and a retry is offered.
 * - No `localStorage` backup (privacy on shared machines).
 * - The editor isn't in a dialog, since Escape would close it. `updateNote` never changes
 *   `created_at`.
 *
 * `renderedBody` is Markdown rendered on the server, keeping react-markdown (~150 kB) out of
 * the client bundle. Until `router.refresh()` returns after a save, the raw text is shown.
 */

const AUTOSAVE_DELAY_MS = 800;

export interface NoteCardProps {
  note: NoteView;
  /** What this note is attached to, if anything. */
  anchorLabel?: string | undefined;
  /** The note body, rendered from Markdown on the server. */
  renderedBody: React.ReactNode;
}

export function NoteCard({ note, anchorLabel, renderedBody }: NoteCardProps) {
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

  // Debounced autosave.
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
          {saved === note.body ? (
            renderedBody
          ) : (
            // Local edit not yet refreshed from the server.
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{saved}</p>
          )}
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
            {/* Cancel gets initial focus, not the destructive action. */}
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
