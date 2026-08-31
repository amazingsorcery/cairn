"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Power, PowerOff } from "lucide-react";

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
import { setConnectorEnabled } from "@/lib/actions/connectors";

/**
 * The kill-switch. ADR 0011 rule 6, ADR 0012 §1, `states.md` §11.6.
 *
 * "A source that changes its terms can be disabled without a deploy." This is the control
 * that makes that true, and three things about it are deliberate.
 *
 * 1. **Switching OFF is confirmed; switching ON is not.** Off is the safe direction and its
 *    consequence is immediate and public — every viewer of the surface sees the switched-off
 *    state — so the operator is told exactly that before they do it. On is the direction that
 *    starts outbound traffic, but it is also the direction an operator only reaches after
 *    having deliberately come here; the asymmetry that matters is that off must be FAST at
 *    3am, and a dialog that explains the blast radius does not slow it meaningfully.
 *
 * 2. **It touches one boolean and nothing else.** `setConnectorEnabled` takes `{ id, enabled }`
 *    and no other field, so turning a source off cannot fail validation on some unrelated
 *    field nobody has filled in. That is the whole point of a kill-switch.
 *
 * 3. **It does not touch `status`.** Operational and editorial are separate axes (ADR 0012 §1),
 *    so re-publishing cannot silently re-enable something an operator switched off.
 *
 * The switch takes effect on the very next request: `getLiveConnector` is deliberately
 * uncached, so there is no TTL between this click and the calls stopping.
 */

export interface KillSwitchProps {
  id: string;
  name: string;
  enabled: boolean;
  /** The reader-facing surface this connector feeds, e.g. "/live/flights". */
  surface: string;
}

export function KillSwitch({ id, name, enabled, surface }: KillSwitchProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function apply(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setConnectorEnabled({ id, enabled: next });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!enabled) {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <Button className="h-11" disabled={pending} onClick={() => apply(true)}>
          <Power className="size-4" aria-hidden="true" />
          {pending ? "switching on…" : "switch on"}
        </Button>
        {error ? (
          <span role="alert" className="max-w-prose text-sm text-destructive">
            {error}
          </span>
        ) : null}
      </span>
    );
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
        <Button variant="destructive" className="h-11">
          <PowerOff className="size-4" aria-hidden="true" />
          switch off
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Switch off {name}?</DialogTitle>
          <DialogDescription>
            Every viewer of <span className="font-mono">{surface}</span> immediately sees the
            switched-off state instead of data. No outbound call will be made until you switch it
            back on.
          </DialogDescription>
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
          <Button variant="destructive" className="h-11" disabled={pending} onClick={() => apply(false)}>
            {pending ? "switching off…" : "switch off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
