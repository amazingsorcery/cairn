"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/result";

/**
 * A Server Action behind one button, for the reversible operations that do not warrant a
 * dialog — publish, unpublish, switch a connector back on.
 *
 * A FAILURE IS SHOWN, NEVER SWALLOWED. `publishTool` and `publishCamera` fail when the
 * database's publish gate refuses the row, and the whole point of that gate is that the
 * editor is told which field is missing rather than watching a button do nothing
 * (states.md §11.3). The message rendered here is the one `guard()` mapped from the
 * constraint name; the constraint name itself never reaches the screen.
 */

export interface ActionButtonProps {
  action: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  id: string;
  label: string;
  pendingLabel?: string;
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  className?: string;
}

export function ActionButton({
  action,
  id,
  label,
  pendingLabel = "saving…",
  variant = "secondary",
  className,
}: ActionButtonProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        variant={variant}
        className="h-11"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await action({ id });
            if (!result.ok) {
              setError(result.message);
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? pendingLabel : label}
      </Button>
      {/*
        The message is announced as well as shown. An editor who submits with the keyboard and
        does not move their focus would otherwise get no signal that the write was refused.
      */}
      {error ? (
        <span role="alert" className="max-w-prose text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
