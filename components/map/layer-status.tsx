"use client";

import * as React from "react";
import {
  ClipboardCheck,
  Clock,
  CloudOff,
  FileWarning,
  Info,
  PowerOff,
  Radio,
  Settings2,
  Shuffle,
  TimerOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatAge, formatClockUtc } from "@/components/live/live-format";
import { useLiveAge } from "@/components/live/use-live-age";
import { cn, formatTimestamp } from "@/lib/utils";
import type { SourceFailure } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * One layer's source, age and state: the per-layer version of `FreshnessBar`.
 *
 * Reuses `useLiveAge` and the formatters from `components/live/` so ages match across
 * pages, but keeps its own vocabulary (`SourceFailure`, not `DegradedReason`); the two only
 * overlap on two kinds.
 *
 * No spinner; age is computed from `observedAt` each tick; each failure kind gets its own
 * sentence; a failure only affects its own layer.
 */

/** `Record` over every failure kind, so a new kind is a compile error here. */
const FAILURE_ICON: Record<SourceFailure["kind"], LucideIcon> = {
  upstreamError: CloudOff,
  rateLimited: Info,
  quotaExhausted: Info,
  // Neither a parser problem nor an outage.
  redirected: Shuffle,
  schemaChanged: FileWarning,
  timeout: TimerOff,
  notConfigured: Settings2,
  disabled: PowerOff,
};

/**
 * Tone per kind. `info` where nothing is broken (rate limit, our quota, not configured,
 * disabled). `warning` for `schemaChanged` and `redirected`: usually ours to fix, not an
 * upstream outage.
 */
const FAILURE_TONE: Record<SourceFailure["kind"], "destructive" | "warning" | "info"> = {
  upstreamError: "destructive",
  rateLimited: "info",
  quotaExhausted: "info",
  redirected: "warning",
  schemaChanged: "warning",
  timeout: "destructive",
  notConfigured: "info",
  disabled: "info",
};

/**
 * Whether a retry control is offered. Not for `rateLimited` (the source asked us to stop),
 * `quotaExhausted`/`disabled`/`notConfigured` (retry can't help) or `schemaChanged` (needs a
 * deploy).
 */
const FAILURE_RETRYABLE: Record<SourceFailure["kind"], boolean> = {
  upstreamError: true,
  rateLimited: false,
  quotaExhausted: false,
  // May be temporary (maintenance); a retry is one request paced at the source TTL.
  redirected: true,
  schemaChanged: false,
  timeout: true,
  notConfigured: false,
  disabled: false,
};

const TONE_CLASS = {
  success: "border-success/40 bg-success/10 [&_svg]:text-success",
  warning: "border-warning/40 bg-warning/10 [&_svg]:text-warning",
  destructive: "border-destructive/40 bg-destructive/10 [&_svg]:text-destructive",
  info: "border-info/40 bg-info/10 [&_svg]:text-info",
} as const;

/** Ends a clause with a full stop, without doubling one that is already there. */
function endSentence(clause: string): string {
  const trimmed = clause.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The sentence for each failure: what happened, then what to do (or why there's nothing). */
export function failureSentence(failure: SourceFailure, sourceName: string): string {
  switch (failure.kind) {
    case "upstreamError":
      return failure.status !== undefined
        ? `${sourceName} answered with HTTP ${failure.status}. Nothing recent enough to show, so this layer is empty rather than out of date.`
        : `${sourceName} could not be reached. Nothing recent enough to show, so this layer is empty rather than out of date.`;
    case "rateLimited":
      return failure.retryAfterSeconds !== undefined
        ? `${sourceName} asked us to slow down and to wait ${failure.retryAfterSeconds} seconds, so we stopped. Their limit is theirs to set. Nothing is broken at either end and this layer will not keep asking in the meantime.`
        : `${sourceName} asked us to slow down, so we stopped. Their limit is theirs to set. Nothing is broken at either end and this layer will not keep asking in the meantime.`;
    case "quotaExhausted":
      // Make clear the limit is ours, not the source's.
      return failure.resetsAt !== undefined
        ? `We reached the polling budget we set ourselves for ${sourceName}, so this layer paused until ${formatTimestamp(failure.resetsAt)}. The source is fine; the limit is ours.`
        : `We reached the polling budget we set ourselves for ${sourceName}, so this layer paused. The source is fine; the limit is ours.`;
    case "redirected":
      // Don't render the destination host: it's from an upstream `Location` header. It's in
      // the structured log.
      return `${sourceName} answered by redirecting us to another host, which we do not follow — an open redirect is how a trusted source becomes a request somewhere else. Nothing was fetched. This is ours to check: either they have moved, or something is answering for them.`;
    case "schemaChanged":
      return `${sourceName} sent a response in a shape we do not recognise, so we stopped reading it rather than guess at it. This is our parser to fix, not their outage, and the fix needs a deploy.`;
    case "timeout":
      return `${sourceName} did not answer within ${Math.round(failure.afterMs / 1000)} seconds. The other layers are unaffected.`;
    case "notConfigured":
      return `This layer needs ${failure.missingEnvVar}, which this deployment does not set. It is switched off rather than broken, and no request was made.`;
    case "disabled":
      /*
       * `reason` (from `disabledReason` in `lib/sources/governed.ts`) is a clause without a
       * full stop, hence `endSentence`. The opening is neutral because `disabledReason` covers
       * four cases (switched off, unpublished, no recorded terms, no row), not just a switch.
       * No possessive on the source name ("USGS earthquakes's").
       */
      return `This layer is off, and that is a decision on our side rather than a fault at the source's end: ${endSentence(failure.reason)} It stays off until we change it.`;
  }
}

/**
 * `31 August 2026` (UTC) for a hand-checked registry, whose `observedAt` is a verification
 * date. A date rather than a clock time or age. Also used by `map-surface.tsx`.
 */
export function formatCheckedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an unrecorded date";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export interface LayerStatusProps {
  label: string;
  unavailableTitle: string;
  payload: LayerPayloadDto;
  /** Feed or hand-checked registry, from `MapLayerDefinition.cadence`. */
  cadence: "live" | "registry";
  /** True only while a revalidation for this layer is in flight. */
  refreshing: boolean;
  /** Age in whole seconds at server render time, to match the server HTML on hydration. */
  initialAgeSeconds: number | null;
  onRetry: () => void;
  className?: string;
}

export function LayerStatus({
  label,
  unavailableTitle,
  payload,
  cadence,
  refreshing,
  initialAgeSeconds,
  onRetry,
  className,
}: LayerStatusProps) {
  const observedAt = payload.ok ? payload.observedAt : null;
  const age = useLiveAge(observedAt, initialAgeSeconds);

  if (!payload.ok) {
    const sourceName = payload.source?.name ?? "The source";
    const Icon = FAILURE_ICON[payload.failure.kind];
    return (
      <div
        className={cn(
          "rounded-md border p-3 text-sm",
          TONE_CLASS[FAILURE_TONE[payload.failure.kind]],
          className,
        )}
      >
        <p className="flex items-start gap-2 font-medium text-foreground">
          <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{unavailableTitle}</span>
        </p>
        <p className="mt-1.5 leading-relaxed text-foreground-secondary">
          {failureSentence(payload.failure, sourceName)}
        </p>
        {payload.lastGoodAt ? (
          <p className="mt-1.5 tabular text-foreground-secondary">
            Last good data{" "}
            <time dateTime={payload.lastGoodAt}>{formatClockUtc(payload.lastGoodAt)}</time>.
          </p>
        ) : null}
        {FAILURE_RETRYABLE[payload.failure.kind] ? (
          <Button variant="secondary" className="mt-3 h-11" onClick={onRetry}>
            {/* A word, not a spinner. */}
            {refreshing ? "checking…" : `retry ${label.toLowerCase()}`}
          </Button>
        ) : null}
      </div>
    );
  }

  /* A registry shows the date it was checked and no age; a feed shows "Live" and its age. */
  const isRegistry = cadence === "registry";
  const Icon = payload.stale ? Clock : isRegistry ? ClipboardCheck : Radio;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        TONE_CLASS[payload.stale ? "warning" : "success"],
        className,
      )}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium tabular text-foreground">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {isRegistry ? (
          <>
            <span>{payload.stale ? "Last checked" : "Checked"}</span>
            <time dateTime={payload.observedAt}>{formatCheckedDate(payload.observedAt)}</time>
            {payload.stale ? (
              <>
                <span aria-hidden="true">·</span>
                {/* Not "stale": the list doesn't age, we just couldn't re-read it. */}
                <span className="font-normal">we could not re-read it</span>
              </>
            ) : null}
          </>
        ) : (
          <>
            <span>{payload.stale ? "Stale" : "Live"}</span>
            <span aria-hidden="true">·</span>
            <span>
              as of <time dateTime={payload.observedAt}>{formatClockUtc(payload.observedAt)}</time>
            </span>
            {age === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatAge(age)}</span>
              </>
            )}
          </>
        )}
        {payload.stale && refreshing ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-normal">refreshing</span>
          </>
        ) : null}
      </p>
      <SourceLine source={payload.source} />
    </div>
  );
}

/**
 * Source link plus the attribution its licence requires, shown next to the data. Text comes
 * from `SourceAdapter.attribution`.
 */
export function SourceLine({
  source,
}: {
  source: { name: string; homepage: string; attribution: { text: string; href?: string; licence: string } };
}) {
  return (
    <p className="mt-1 text-foreground-secondary">
      <a
        href={source.homepage}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline underline-offset-4 hover:text-foreground"
      >
        {source.name}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <span aria-hidden="true"> · </span>
      {source.attribution.href ? (
        <a
          href={source.attribution.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-4 hover:text-foreground"
        >
          {source.attribution.text}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span>{source.attribution.text}</span>
      )}
      <span aria-hidden="true"> · </span>
      <span>{source.attribution.licence}</span>
    </p>
  );
}
