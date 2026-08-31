"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAnnounce } from "./announcer";

/**
 * Copy one value to the clipboard.
 *
 * Two details that are easy to leave out and that matter here:
 *
 *   - The confirmation is announced, not only shown, through the route's single live region
 *     (`announcer.tsx`). A sighted reader sees the tick; a screen-reader user gets nothing
 *     otherwise, and "did that copy?" is precisely the question you cannot answer by looking
 *     at a clipboard.
 *   - Failure is reported. `navigator.clipboard` rejects in an insecure context and when the
 *     document is not focused. Silently doing nothing means a reader pastes the *previous*
 *     hash into their notes, which for this audience is an error rather than an annoyance.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** What is being copied, for the button's accessible name: "Copy SHA-256". */
  label: string;
  className?: string;
}) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  const announce = useAnnounce();

  React.useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      announce(`${label} copied to the clipboard.`);
    } catch {
      setState("failed");
      announce(`${label} could not be copied. Select the text and copy it manually.`);
    }
  }, [value, label, announce]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("shrink-0", className)}
      onClick={() => {
        void copy();
      }}
      disabled={value.length === 0}
      aria-label={`Copy ${label}`}
      title={state === "failed" ? "Could not copy — select the text instead" : `Copy ${label}`}
    >
      {state === "copied" ? (
        <Check className="size-4 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
    </Button>
  );
}
