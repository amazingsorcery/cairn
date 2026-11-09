"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult } from "@/lib/actions/result";

/**
 * Confirmation dialog around one Server Action. Confirming accuracy is recorded against the
 * editor's id, so it shouldn't be a one-click button.
 *
 * The action is passed in rather than dispatched from a client-side `kind` string. Each
 * action re-checks session and role itself, since Server Actions are public endpoints.
 */

export interface ConfirmActionProps {
  /** The Server Action to run. Receives `{ id }`. */
  action: (input: unknown) => Promise<ActionResult<{ id: string }>>;
  id: string;
  triggerLabel: string;
  triggerVariant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
}

export function ConfirmAction({
  action,
  id,
  triggerLabel,
  triggerVariant = "default",
  title,
  description,
  confirmLabel,
}: ConfirmActionProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await action({ id });
      if (!result.ok) {
        // Already user-safe: `guard()` in `lib/actions/result.ts` maps DB errors to sentences.
        setError(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} className="h-11 w-full sm:w-auto">
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="mt-6">
          <DialogClose asChild>
            <Button variant="outline" className="h-11">
              cancel
            </Button>
          </DialogClose>
          <Button className="h-11" onClick={run} disabled={pending}>
            {pending ? "saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
