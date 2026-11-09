"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Text-only autosave indicator (no spinner: there is nothing to wait for).
 *
 * Failures use `role="status"` so screen readers announce them without moving focus, and
 * come with a retry button.
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
