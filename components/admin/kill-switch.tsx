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
 * Connector kill-switch: disables a source without a deploy.
 *
 * - Switching off is confirmed (it's immediately visible to every viewer); switching on isn't.
 * - Only touches `enabled`, so it can't fail validation on unrelated fields.
 * - Doesn't touch `status`, so re-publishing can't re-enable a switched-off connector.
 *
 * Takes effect on the next request; `getLiveConnector` is uncached.
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
