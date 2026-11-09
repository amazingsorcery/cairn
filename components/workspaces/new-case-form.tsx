"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWorkspace } from "@/lib/actions/workspaces";
import { useUnsavedGuard } from "./use-unsaved-guard";

/**
 * Create a case via `createWorkspace`, which builds the checklist from the playbook's
 * published steps in one transaction.
 *
 * `playbookId` isn't trusted: the action reads step titles from published playbooks only,
 * so a forged id yields an empty checklist.
 *
 * The prefilled title is selected on mount so renaming is one keystroke.
 */

export interface NewCaseFormProps {
  playbookId: string | null;
  defaultTitle: string;
  /** Where to go if the reader abandons the form. */
  cancelHref: string;
}

export function NewCaseForm({ playbookId, defaultTitle, cancelHref }: NewCaseFormProps) {
  const router = useRouter();
  const titleId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(defaultTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard an edited, non-empty title.
  useUnsavedGuard(!pending && title.trim() !== defaultTitle.trim() && title.trim() !== "");

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await createWorkspace({ title: title.trim(), playbookId });

    if (!result.ok) {
      setPending(false);
      if (result.code === "unauthenticated") {
        // Keep the typed text; sign-in returns to this form.
        setError("You were signed out. Sign back in — your text is still here.");
        return;
      }
      setError(result.fieldErrors?.title?.[0] ?? result.message);
      inputRef.current?.focus();
      return;
    }

    router.replace(`/workspaces/${result.data.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 max-w-[52ch]" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={titleId}>name this case</Label>
        <Input
          ref={inputRef}
          id={titleId}
          name="title"
          value={title}
          maxLength={160}
          onChange={(event) => {
            setTitle(event.target.value);
            if (error) setError(null);
          }}
          className="h-11"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <p className="text-xs text-muted-foreground">
          Only you can see this. Rename it any time from the case itself.
        </p>
        {error ? (
          <p id={errorId} role="status" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={pending || title.trim() === ""}>
          {pending ? "starting…" : "start the case"}
        </Button>
        <Button asChild variant="outline" size="lg">
          <a href={cancelHref}>cancel</a>
        </Button>
      </div>
    </form>
  );
}
