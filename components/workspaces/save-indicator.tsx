"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The autosave indicator: three states, TEXT ONLY, never a spinner
 * (`docs/design/states.md` §7.4, wireframe 07).
 *
 * A spinner claims that something is happening that the reader must wait for. Nothing here
 * is worth waiting for — the text is already in the field and it is going to be saved — so
 * the indicator reports and does not perform.
 *
 * On failure the message is `--destructive`, carries `role="status"` so a screen reader
 * hears it without being dragged away from the textarea, and the retry is a REAL BUTTON.
 * An error with no next action is a dead end (`states.md` §0).
 */

export type SaveState =
  | { status: "clean" }
  | { status: "dirty" }
  | { status: "saving" }
  | { status: "saved"; at: Date }
  | { status: "failed"; message: string };

/** `14:32`, UTC, to match every other timestamp in a case file. */
function clock(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(at);
}

export function SaveIndicator({
  state,
  onRetry,
  className,
}: {
  state: SaveState;
  onRetry?: () => void;
  className?: string;
}) {
  if (state.status === "clean") return null;

  if (state.status === "failed") {
    return (
      <span className={cn("flex flex-wrap items-center gap-2", className)}>
        <span role="status" className="text-xs text-destructive">
          not saved — {state.message}
        </span>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={onRetry}>
            retry
          </Button>
        ) : null}
      </span>
    );
  }

  return (
    <span
      role="status"
      className={cn("tabular text-xs text-muted-foreground", className)}
    >
      {state.status === "saving"
        ? "saving…"
        : state.status === "saved"
          ? `saved ${clock(state.at)}`
          : "unsaved"}
    </span>
  );
}
