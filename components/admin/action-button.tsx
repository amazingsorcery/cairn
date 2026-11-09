"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/result";

/**
 * One-button Server Action for reversible operations (publish, unpublish, re-enable).
 * Failures are always shown, e.g. the publish gate naming a missing field; the message is
 * the one `guard()` mapped, never the raw constraint name.
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
      {/* role="alert" so keyboard users hear the refusal without moving focus. */}
      {error ? (
        <span role="alert" className="max-w-prose text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
