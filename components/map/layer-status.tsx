"use client";

import * as React from "react";
import { Clock, CloudOff, FileWarning, Info, PowerOff, Radio, Settings2, TimerOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatAge, formatClockUtc } from "@/components/live/live-format";
import { useLiveAge } from "@/components/live/use-live-age";
import { cn } from "@/lib/utils";
import type { SourceFailure } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * One layer's source, age and state. ADR 0014, applied per layer instead of per page.
 *
 * ## What is carried over from `components/live/freshness-bar.tsx`
 *
 * The rules, and the two pieces of machinery that implement them. `useLiveAge` and
 * `formatAge`/`formatClockUtc` are IMPORTED from `components/live/`, not copied: the age on
 * this map and the age on `/live/flights` must be the same number computed the same way, and
 * two copies of a clock is how they stop being.
 *
 * What is not shared is the vocabulary. `FreshnessBar` speaks `ConnectorState` and
 * `DegradedReason` from `lib/connectors/types.ts`; a map layer speaks `SourceFailure` from
 * `lib/sources/types.ts`, which has six kinds and only two of them in common. Mapping one
 * onto the other would have required inventing a `LiveReason` for `schemaChanged` and
 * `notConfigured`, which is how a UI ends up rendering "upstream is down" for a bug in our
 * own parser. Two vocabularies, one set of rules, no translation layer.
 *
 * ## The rules, restated because they are easy to undo
 *
 * 1. **Never a spinner** (ADR 0011 rule 5, ADR 0014 §8). "refreshing" is a word, shown only
 *    while a revalidation is genuinely in flight. A spinner keeps asserting that fresh data
 *    is arriving after the request has already failed.
 * 2. **The age is computed from the observation instant on every tick**, never from a timer
 *    started at mount. The second number is the age of the page, which is a different thing.
 * 3. **Different failures get different sentences.** "It broke" is not a state. Each of the
 *    six says what is wrong, and two of them say plainly that there is nothing to retry.
 * 4. **A dead source degrades ITS OWN LAYER.** This component renders inside one layer's
 *    row; nothing about it can affect another layer or the map.
 */

/**
 * Every failure kind, exhaustively. `Record<SourceFailure["kind"], …>` is doing real work:
 * a seventh kind added to `lib/sources/types.ts` is a compile error here, which is exactly
 * where a missing icon and a missing sentence should surface — rather than in production as
 * a blank row. `components/live/live-format.ts` learned this the hard way (QA finding Q-02).
 */
const FAILURE_ICON: Record<SourceFailure["kind"], LucideIcon> = {
  upstreamError: CloudOff,
  rateLimited: Info,
  schemaChanged: FileWarning,
  timeout: TimerOff,
  notConfigured: Settings2,
  disabled: PowerOff,
};

/**
 * Tone per kind.
 *
 * `rateLimited`, `notConfigured` and `disabled` are `info`, not `warning`: nothing is broken.
 * A source asking us to slow down, a key we have not set, and a switch we flipped are all
 * decisions being respected, and colouring them as faults blames a third party for our own
 * choices.
 *
 * `schemaChanged` is `warning` rather than `destructive` because it is usually OUR bug, not
 * theirs — the upstream changed something it is entitled to change and our parser has not
 * caught up. The copy says so.
 */
const FAILURE_TONE: Record<SourceFailure["kind"], "destructive" | "warning" | "info"> = {
  upstreamError: "destructive",
  rateLimited: "info",
  schemaChanged: "warning",
  timeout: "destructive",
  notConfigured: "info",
  disabled: "info",
};

/**
 * Whether a retry control is offered.
 *
 * `rateLimited` is false and it is not about honesty but about conduct: a retry control is
 * an invitation to keep calling a service that has just asked us to stop, which is the
 * behaviour product-brief §3.2 constraint 5 forbids. `disabled` and `notConfigured` are
 * false because retrying cannot help and offering it would be a lie about the reader's
 * options. `schemaChanged` is false because a deploy fixes it and a reader cannot deploy.
 */
const FAILURE_RETRYABLE: Record<SourceFailure["kind"], boolean> = {
  upstreamError: true,
  rateLimited: false,
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

/**
 * The sentence for each failure. Two clauses: what happened, then what to do — and where
 * there is nothing to do, why. No apology and no "something went wrong"
 * (`docs/design/states.md` §0).
 */
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
    case "schemaChanged":
      return `${sourceName} sent a response in a shape we do not recognise, so we stopped reading it rather than guess at it. This is our parser to fix, not their outage, and the fix needs a deploy.`;
    case "timeout":
      return `${sourceName} did not answer within ${Math.round(failure.afterMs / 1000)} seconds. The other layers are unaffected.`;
    case "notConfigured":
      return `This layer needs ${failure.missingEnvVar}, which this deployment does not set. It is switched off rather than broken, and no request was made.`;
    case "disabled":
      return `We have switched this layer off: ${failure.reason} It stays off until we turn it back on; it is not a fault at ${sourceName}'s end.`;
  }
}

export interface LayerStatusProps {
  label: string;
  unavailableTitle: string;
  payload: LayerPayloadDto;
  /** True only while a revalidation for THIS layer is genuinely in flight. */
  refreshing: boolean;
  /**
   * Age in whole seconds at server render time, so the first client render matches the
   * server HTML exactly and the age is present in the no-JavaScript rendering too.
   */
  initialAgeSeconds: number | null;
  onRetry: () => void;
  className?: string;
}

export function LayerStatus({
  label,
  unavailableTitle,
  payload,
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
            {/* A word, never a spinner. ADR 0014 §8. */}
            {refreshing ? "checking…" : `retry ${label.toLowerCase()}`}
          </Button>
        ) : null}
      </div>
    );
  }

  const Icon = payload.stale ? Clock : Radio;

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
 * Where the data came from and the credit its licence requires, rendered at the point of
 * display rather than in a page footer.
 *
 * The text comes from `SourceAdapter.attribution` and is never typed into a component. That
 * is what makes it impossible for the UI to forget: a layer cannot render its status without
 * having been handed the credit, and several of these licences make attribution a condition
 * of use — so a missing line is a licence breach, not a polish defect.
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
