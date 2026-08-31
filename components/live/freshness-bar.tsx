"use client";

import * as React from "react";
import { Clock, CloudOff, Info, PowerOff, Radio } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { ageSeconds, formatAge, formatClockUtc, type LiveReason, type LiveState } from "./live-format";

/**
 * The age indicator. ADR 0014 and `docs/design/states.md` §5.
 *
 * ONE component, used by every Live surface, with exactly three states. There is no fourth
 * and no state in which it is absent: it occupies the same row whatever is happening, so
 * the layout does not shift when the state changes and a reader who glances at a fixed spot
 * always finds the age (`wireframes/08-live-flights.txt`, Notes).
 *
 * WHY THIS IS A CLIENT COMPONENT, and the only exception to RSC-by-default on these routes:
 * the age ticks. A server-rendered "8s ago" is wrong within a second, and the age is the one
 * number on a Live page that must never be wrong (ADR 0014 §1).
 *
 * WHY `initialAgeSeconds` IS A PROP rather than computed at mount: the first client render
 * has to match the server HTML or React discards it as a hydration mismatch. The server
 * computes the age once, passes it in, and the interval takes over from there — so the age
 * is present and correct in the no-JavaScript rendering too.
 *
 * NEVER A SPINNER. "refreshing" is a word in the bar, shown only while a revalidation is
 * genuinely in flight; if revalidation has failed the surface moves to `unavailable` rather
 * than sitting there claiming to refresh (states.md §5.3).
 */

const UNAVAILABLE_ICON: Record<LiveReason, LucideIcon> = {
  "upstream-down": CloudOff,
  stale: Clock,
  "quota-exhausted": Info,
  disabled: PowerOff,
};

/**
 * Tone per reason. `quota-exhausted` and `disabled` are `--info`, not `--warning`: nothing
 * is broken. A ceiling we set and a switch we flipped are decisions, and colouring them as
 * faults would blame a third party for our own choices (states.md §5.5, §5.6).
 */
const UNAVAILABLE_TONE: Record<LiveReason, "destructive" | "info"> = {
  "upstream-down": "destructive",
  stale: "destructive",
  "quota-exhausted": "info",
  disabled: "info",
};

const TONE_CLASS = {
  success: "border-success/40 bg-success/10 text-foreground [&_svg]:text-success",
  warning: "border-warning/40 bg-warning/10 text-foreground [&_svg]:text-warning",
  destructive: "border-destructive/40 bg-destructive/10 text-foreground [&_svg]:text-destructive",
  info: "border-info/40 bg-info/10 text-foreground [&_svg]:text-info",
} as const;

export interface FreshnessBarProps {
  state: LiveState;
  /** ISO 8601 instant the upstream answered, or null when no payload was ever obtained. */
  fetchedAt: string | null;
  /** Age in whole seconds at server render time. Keeps hydration honest. */
  initialAgeSeconds: number | null;
  reason: LiveReason | null;
  /** True only while a revalidation is genuinely in flight. */
  refreshing?: boolean;
  /** The headline for `unavailable`, e.g. "Aircraft positions paused". Surface-specific. */
  unavailableTitle: string;
  /** The word used for a fresh surface. "Live" on flights. */
  freshLabel?: string;
  className?: string;
}

export function FreshnessBar({
  state,
  fetchedAt,
  initialAgeSeconds,
  reason,
  refreshing = false,
  unavailableTitle,
  freshLabel = "Live",
  className,
}: FreshnessBarProps) {
  const [age, setAge] = React.useState<number | null>(initialAgeSeconds);

  React.useEffect(() => {
    if (!fetchedAt) {
      setAge(null);
      return;
    }
    setAge(ageSeconds(fetchedAt));
    const timer = window.setInterval(() => setAge(ageSeconds(fetchedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [fetchedAt]);

  if (state === "unavailable") {
    const key: LiveReason = reason ?? "upstream-down";
    const Icon = UNAVAILABLE_ICON[key];
    return (
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium",
          TONE_CLASS[UNAVAILABLE_TONE[key]],
          className,
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span>{unavailableTitle}</span>
      </div>
    );
  }

  const clock = fetchedAt ? formatClockUtc(fetchedAt) : null;
  const relative = age === null ? null : formatAge(age);
  const isStale = state === "stale";
  const Icon = isStale ? Clock : Radio;

  return (
    <div
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2",
        "text-sm font-medium tabular",
        TONE_CLASS[isStale ? "warning" : "success"],
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{isStale ? "Stale" : freshLabel}</span>
      {clock ? (
        <>
          <span aria-hidden="true">·</span>
          <span>as of {clock}</span>
        </>
      ) : null}
      {relative ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{relative}</span>
        </>
      ) : null}
      {isStale && refreshing ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-normal">refreshing</span>
        </>
      ) : null}
    </div>
  );
}
