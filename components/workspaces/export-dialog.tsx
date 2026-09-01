"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Export a case to Markdown or PDF (`docs/design/flows.md` 4, `states.md` 7.6 / 7.7).
 *
 * MARKDOWN IS IMMEDIATE and needs no state: the handler streams it straight back with
 * `Content-Disposition: attachment`, so a plain navigation downloads it without leaving the
 * page.
 *
 * PDF IS GENERATED SERVER-SIDE and is one of exactly two spinners in the product — and even
 * here it is a spinner WITH TEXT saying what is happening, plus an elapsed count, plus a
 * different sentence past 20 seconds. An indeterminate spinner with no text would be the
 * thing `states.md` 0 forbids.
 *
 * THE DIALOG CANNOT BE DISMISSED BY CLICKING AWAY MID-EXPORT. Only the explicit `cancel`
 * closes it, and that button states that cancelling changes nothing in the case — because
 * the user's first question after any export trouble is whether their case survived.
 *
 * ON FAILURE the dialog STAYS OPEN with the error and a retry, and offers Markdown as the
 * escape hatch. The case is untouched and the copy says so.
 */

const SLOW_AFTER_SECONDS = 20;

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  counts: { notes: number; tools: number; steps: number; features: number };
  /**
   * The control that opened this dialog. Focus goes back to it on close.
   *
   * Q-09. Radix restores focus to its own `DialogTrigger` for free, but this dialog is driven
   * by controlled `open` state from the header rather than by a trigger element, so Radix has
   * nothing to restore to and focus lands on `<body>`. Handing it the trigger explicitly is
   * the smaller change of the two the audit offered, and it keeps the dialog mountable on
   * demand — which is what Q-12 needed.
   */
  returnFocusTo?: RefObject<HTMLButtonElement | null>;
}

type Phase =
  | { kind: "choosing" }
  | { kind: "building"; startedAt: number }
  | { kind: "failed"; message: string };

export function ExportDialog({
  open,
  onOpenChange,
  workspaceId,
  counts,
  returnFocusTo,
}: ExportDialogProps) {
  const groupId = useId();
  const [format, setFormat] = useState<"md" | "pdf">("md");
  const [phase, setPhase] = useState<Phase>({ kind: "choosing" });
  const [elapsed, setElapsed] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const building = phase.kind === "building";

  useEffect(() => {
    if (!building) return;
    const started = phase.startedAt;
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [building, phase]);

  useEffect(() => {
    if (open) return;
    abort.current?.abort();
    abort.current = null;
    setPhase({ kind: "choosing" });
  }, [open]);

  const summary = `${counts.notes} ${counts.notes === 1 ? "note" : "notes"} with timestamps, ${counts.tools} saved ${counts.tools === 1 ? "tool" : "tools"} with their confidence and last-verified dates, ${counts.features} saved map ${counts.features === 1 ? "feature" : "features"} with the attribution and licence each one is owed, and ${counts.steps} checklist ${counts.steps === 1 ? "step" : "steps"}.`;

  function exportMarkdown() {
    // A navigation, not a fetch: `Content-Disposition: attachment` means the browser saves
    // the file and stays on this page. Nothing to wait for, so nothing to report.
    window.location.href = `/workspaces/${workspaceId}/export?format=md`;
    onOpenChange(false);
  }

  async function exportPdf() {
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "building", startedAt: Date.now() });

    try {
      const response = await fetch(`/workspaces/${workspaceId}/export?format=pdf`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFrom(response) ?? "case.pdf";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      // The dialog closes only on a confirmed response (`flows.md` 4, step 5).
      onOpenChange(false);
    } catch (error) {
      if (controller.signal.aborted) {
        setPhase({ kind: "choosing" });
        return;
      }
      setPhase({
        kind: "failed",
        message: error instanceof Error ? error.message : "the file was not created",
      });
    } finally {
      abort.current = null;
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Mid-export the only way out is the explicit cancel button.
        if (!next && building) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        closeLabel="close this dialog"
        onPointerDownOutside={(event) => {
          if (building) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (building) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // Take the restore away from Radix — it has no trigger to aim at here — and put
          // focus back on the button that opened the dialog. Without this it goes to `<body>`
          // and a keyboard user is returned to the top of the document (Q-09).
          const trigger = returnFocusTo?.current;
          if (!trigger) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        {phase.kind === "building" ? (
          <>
            <DialogHeader>
              <DialogTitle>Building your PDF</DialogTitle>
              <DialogDescription>
                {counts.notes} notes, {counts.tools} saved tools, {counts.features} saved map
                features, {counts.steps} checklist
                steps. This usually takes a few seconds.
              </DialogDescription>
            </DialogHeader>
            <p role="status" className="tabular text-sm text-foreground-secondary">
              {elapsed}s
              {elapsed >= SLOW_AFTER_SECONDS
                ? " · Still building. Large cases with many notes take longer."
                : null}
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  abort.current?.abort();
                  setPhase({ kind: "choosing" });
                }}
              >
                cancel
              </Button>
            </DialogFooter>
            <p className="mt-2 text-xs text-muted-foreground">
              Cancelling changes nothing in the case.
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Export this case</DialogTitle>
              <DialogDescription>Includes {summary}</DialogDescription>
            </DialogHeader>

            {phase.kind === "failed" ? (
              <div role="status" className="rounded-md border border-destructive/40 bg-destructive/10 p-3">
                <p className="text-sm font-medium">Export didn&rsquo;t finish</p>
                <p className="mt-1 text-sm text-foreground-secondary">
                  The file wasn&rsquo;t created. Your case is unchanged — nothing was removed
                  or altered. Retry, or export to Markdown instead.
                </p>
              </div>
            ) : null}

            <fieldset className="mt-2">
              <legend className="sr-only" id={groupId}>
                export format
              </legend>
              <div className="flex flex-col gap-2">
                <label className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 text-sm">
                  <input
                    type="radio"
                    name="format"
                    value="md"
                    checked={format === "md"}
                    onChange={() => setFormat("md")}
                    className="size-4"
                  />
                  <span>
                    Markdown <span className="text-muted-foreground">— immediate</span>
                  </span>
                </label>
                <label className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3 text-sm">
                  <input
                    type="radio"
                    name="format"
                    value="pdf"
                    checked={format === "pdf"}
                    onChange={() => setFormat("pdf")}
                    className="size-4"
                  />
                  <span>
                    PDF <span className="text-muted-foreground">— takes a few seconds</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Dates in the file are ISO 8601 and the export is stamped with the time it was
              made. It is a snapshot: it does not change when the catalogue does.
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                cancel
              </Button>
              <Button
                type="button"
                onClick={() => (format === "md" ? exportMarkdown() : void exportPdf())}
              >
                {phase.kind === "failed" ? "retry export" : "export"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Prefer the filename the handler chose, so the browser and the server agree. */
function filenameFrom(response: Response): string | null {
  const header = response.headers.get("content-disposition");
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}
