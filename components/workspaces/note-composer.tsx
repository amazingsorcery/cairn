"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { createNote } from "@/lib/actions/workspaces";
import { useUnsavedGuard } from "./use-unsaved-guard";

/**
 * Write a new note.
 *
 * WHY THIS ONE IS NOT AUTOSAVED, WHERE EDITING IS.
 * `flows.md` M1 specifies autosave-on-pause for notes, and `NoteCard` implements exactly
 * that for an existing note. A *new* note is different in kind: autosaving a composer would
 * commit a row the moment the writer paused mid-first-sentence, and `notes.created_at` is
 * the timestamp of the record — it is not editable afterwards and it is the thing an
 * investigator relies on. Creating "Weather rec" at 09:41 because somebody stopped to think
 * puts a false timestamp in an evidence artefact.
 *
 * So the composer takes the other mitigation from the same document: M2, the `beforeunload`
 * guard, armed for as long as there is any text in the box. Nothing typed can be lost to a
 * tab close, a back button or a reload; it just becomes a note when the writer says so.
 * Recorded and justified in `docs/frontend/HANDOFF-workspaces.md` 4.
 *
 * NEVER INSIDE A DIALOG. Escape closes a Radix dialog and Escape is a normal key to press
 * while typing (`states.md` 7.4).
 *
 * On a failed save the text stays in the box, the guard stays armed, and the error names a
 * next action. The signed-out case says so in the words `states.md` 6.10 uses, and does not
 * redirect: a redirect here would discard the note.
 */

export interface NoteComposerProps {
  workspaceId: string;
  /** Attach the note to a checklist entry, or leave null for a case-level note. */
  workspaceItemId?: string | null;
  label: string;
  placeholder: string;
  submitLabel?: string;
  onSaved?: () => void;
}

export function NoteComposer({
  workspaceId,
  workspaceItemId = null,
  label,
  placeholder,
  submitLabel = "add note",
  onSaved,
}: NoteComposerProps) {
  const router = useRouter();
  const fieldId = useId();
  const errorId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useUnsavedGuard(body.trim() !== "");

  async function submit() {
    const candidate = body.trim();
    if (candidate === "" || pending) return;
    setPending(true);
    setError(null);

    const result = await createNote({
      workspaceId,
      body: candidate,
      workspaceItemId,
      playbookStepId: null,
    });
    setPending(false);

    if (!result.ok) {
      setError(
        result.code === "unauthenticated"
          ? "You were signed out. Sign back in — your text is still here and nothing has been lost."
          : (result.fieldErrors?.body?.[0] ?? result.message),
      );
      fieldRef.current?.focus();
      return;
    }

    // Only now is the text safe to drop from the box.
    setBody("");
    onSaved?.();
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <Textarea
        ref={fieldRef}
        id={fieldId}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          if (error) setError(null);
        }}
        placeholder={placeholder}
        className="min-h-24 font-mono text-sm"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />

      {error ? (
        <p id={errorId} role="status" className="mt-2 text-sm text-destructive">
          {error}{" "}
          {error.startsWith("You were signed out") ? (
            <a
              href="/signin"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              sign in
              <span className="sr-only"> (opens in a new tab, so this one keeps your text)</span>
            </a>
          ) : null}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Timestamped when you add it. Markdown is rendered.
        </p>
        <Button type="submit" className="h-11" disabled={pending || body.trim() === ""}>
          {pending ? "saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
