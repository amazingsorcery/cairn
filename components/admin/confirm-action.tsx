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
 * A confirmation dialog around one Server Action. `wireframes/11-admin-queue.txt`.
 *
 * WHY "CONFIRM STILL ACCURATE" IS A DIALOG AND NOT A ONE-CLICK BUTTON: it is an assertion a
 * named human is making about an entry, recorded with their id and today's date. Making it
 * cheap would make it untrue, which would in turn make every confidence value in the public
 * catalogue decorative (ADR 0007 §8).
 *
 * THE ACTION IS PASSED IN, not chosen here. Tools, playbooks, cameras and connectors each
 * have their own action with its own role check and its own revalidation set; a single
 * dispatcher taking a `kind` string would put that choice on the client, where it is an
 * attacker's to make. Whatever is passed, the action re-checks the session and the role
 * against the database before it writes — a Server Action is a public HTTP endpoint with a
 * generated name, and its authorisation is not inherited from the page that rendered it.
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
        // The message is one sentence written for an editor. A database error, a constraint
        // name or a stack never reaches here — `guard()` in `lib/actions/result.ts` maps
        // constraint names to sentences and logs the rest.
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
