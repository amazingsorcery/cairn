"use client";

import { Clock, CloudOff, Info, PowerOff, Radio } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatAge, formatClockUtc, type LiveReason, type LiveState } from "./live-format";
import { useLiveAge } from "./use-live-age";

/**
 * Age indicator shared by every Live surface. Three states, always rendered in the same row
 * so the layout doesn't shift.
 *
 * Client component because the age ticks. `initialAgeSeconds` comes from the server so the
 * first client render matches the server HTML (and works without JS).
 *
 * No spinner: "refreshing" is shown as a word only while a revalidation is in flight.
 */

const UNAVAILABLE_ICON: Record<LiveReason, LucideIcon> = {
  "upstream-down": CloudOff,
  stale: Clock,
  "quota-exhausted": Info,
  "rate-limited": Info,
  disabled: PowerOff,
  "bad-request": Info,
};

/**
 * Tone per reason. Quota, rate limit and disabled are `info`, not a warning or error:
 * nothing is broken.
 */
const UNAVAILABLE_TONE: Record<LiveReason, "destructive" | "info"> = {
  "upstream-down": "destructive",
  stale: "destructive",
  "quota-exhausted": "info",
  "rate-limited": "info",
  disabled: "info",
  // We rejected the parameters; not an outage.
  "bad-request": "info",
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
  const age = useLiveAge(fetchedAt, initialAgeSeconds);

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
