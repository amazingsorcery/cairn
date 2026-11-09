"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { createNote } from "@/lib/actions/workspaces";
import { useUnsavedGuard } from "./use-unsaved-guard";

/**
 * Compose a new note.
 *
 * Not autosaved (unlike `NoteCard` edits): `notes.created_at` is immutable, so autosaving
 * mid-sentence would record a misleading timestamp. The `beforeunload` guard protects the
 * text instead.
 *
 * Don't put this in a dialog; Escape would close it while typing. On failure the text stays
 * and nothing redirects.
 */

export interface NoteComposerProps {
  workspaceId: string;
  /** Attach the note to a checklist entry, or leave null for a case-level note. */
  workspaceItemId?: string | null;
  label: string;
  placeholder: string;
  submitLabel?: string;
  onSaved?: () => void;
  /**
   * Focus the field on mount. Use when the control that revealed the composer disappears,
   * or focus falls back to `<body>`.
   */
  autoFocus?: boolean;
  /** Rendered beside the submit when the composer can be dismissed again. */
  onCancel?: () => void;
}

export function NoteComposer({
  workspaceId,
  workspaceItemId = null,
  label,
  placeholder,
  submitLabel = "add note",
  onSaved,
  autoFocus = false,
  onCancel,
}: NoteComposerProps) {
  const router = useRouter();
  const fieldId = useId();
  const errorId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useUnsavedGuard(body.trim() !== "");

  useEffect(() => {
    if (autoFocus) fieldRef.current?.focus();
  }, [autoFocus]);

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

    // Saved; safe to clear.
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

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Timestamped when you add it. Markdown is rendered.
        </p>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={onCancel}
              // The unsaved guard still applies if there is text.
            >
              cancel
            </Button>
          ) : null}
          <Button type="submit" className="h-11" disabled={pending || body.trim() === ""}>
            {pending ? "saving…" : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
