"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockUtc } from "./live-format";

/**
 * The controls a degraded Live surface carries.
 *
 * `docs/design/states.md` §0: "Every error region includes a real control — a retry, a
 * link, a way back. An error with no next action is a dead end." These are those controls,
 * and each is a client leaf so the rest of the surface stays a Server Component.
 *
 * Retrying is `router.refresh()`, not a client fetch to the upstream: the whole point of
 * `/api/live/flights` is that the browser never talks to the aggregator (ADR 0011 §1). A
 * refresh re-runs the server render, which goes through `runConnector` and therefore through
 * the kill-switch, the global ceiling and the per-user quota.
 */

export function RetryButton({ label = "retry" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  return (
    <Button
      variant="secondary"
      className="h-11"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RotateCw className="size-4" aria-hidden="true" />
      {pending ? "checking…" : label}
      {/*
        The pending state is a word, never a spinner. ADR 0014 §8: an indeterminate spinner
        keeps asserting that fresh data is arriving even after the request has failed, which
        is the most common way a live UI lies.
      */}
    </Button>
  );
}

/**
 * ", in 4 minutes" — the relative half of a reset time, ticking.
 *
 * The absolute instant is rendered by the caller and never changes; only this ticks. Both
 * are shown because they answer different questions: the absolute time is what a reader
 * checks their own clock against, the relative one is whether it is worth waiting.
 */
export function Countdown({ to }: { to: string }) {
  const target = React.useMemo(() => new Date(to).getTime(), [to]);
  const [remaining, setRemaining] = React.useState(() => Math.max(0, target - Date.now()));

  React.useEffect(() => {
    const timer = window.setInterval(() => setRemaining(Math.max(0, target - Date.now())), 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (remaining <= 0) return <span>, which has now passed</span>;

  const seconds = Math.ceil(remaining / 1000);
  if (seconds < 60) return <span>, in {seconds} seconds</span>;
  const minutes = Math.ceil(seconds / 60);
  return <span>, in {minutes === 1 ? "1 minute" : `${minutes} minutes`}</span>;
}

/**
 * `retry at 14:45` — disabled until a fixed-window quota resets, with a live countdown.
 *
 * The reset instant is real, not a guess: ADR 0009's limiter is a fixed window, so the
 * counter clears at the end of the window the server computed. Once it passes, the button
 * enables itself rather than requiring a page reload — the reader was told when to come
 * back and the control keeps that promise.
 */
export function RetryAtButton({ resetAt }: { resetAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const target = React.useMemo(() => new Date(resetAt).getTime(), [resetAt]);
  const [remaining, setRemaining] = React.useState(() => Math.max(0, target - Date.now()));

  React.useEffect(() => {
    const timer = window.setInterval(() => setRemaining(Math.max(0, target - Date.now())), 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  const seconds = Math.ceil(remaining / 1000);
  const ready = remaining <= 0;
  const clock = formatClockUtc(resetAt);

  return (
    <Button
      variant="secondary"
      className="h-11"
      disabled={!ready || pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RotateCw className="size-4" aria-hidden="true" />
      {ready ? "retry" : `retry at ${clock.replace(" UTC", "")}`}
      {ready ? null : (
        <span className="tabular text-xs font-normal">
          {seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`}
        </span>
      )}
    </Button>
  );
}
