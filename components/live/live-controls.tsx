"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockUtc } from "./live-format";

/**
 * Controls for degraded Live surfaces, as client leaves so the rest stays server-rendered.
 *
 * Retry is `router.refresh()`, never a client fetch to the upstream. The server render goes
 * through `runConnector`, so the kill-switch and quotas still apply.
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
      {/* Pending is shown as a word, not a spinner. */}
    </Button>
  );
}

/** ", in 4 minutes": ticking relative time. The caller renders the absolute instant. */
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
 * `retry at 14:45`: disabled until the fixed-window quota resets, then enables itself
 * without a reload. The reset time is exact because the limiter uses fixed windows.
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
