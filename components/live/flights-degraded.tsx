import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Countdown, RetryAtButton, RetryButton } from "./live-controls";
import { formatAge, formatClockUtc, type LiveReason } from "./live-format";

/**
 * `/live/flights` when there is nothing recent enough to show. `docs/design/states.md`
 * §5.4–§5.6, `wireframes/08-live-flights.txt`.
 *
 * FOUR DIFFERENT THINGS CAN GO WRONG AND THEY NEED FOUR DIFFERENT SENTENCES. "It broke" is
 * not a state (ADR 0011 rule 5). Each of these says what is wrong, how old the last good
 * data was, and what the reader can do about it — including saying, in two of the four
 * cases, that there is nothing to do and why offering a retry would be a lie.
 *
 * Past `cache_ttl + stale_while_revalidate` the surface shows NOTHING rather than something
 * old (ADR 0014 §3). There is a point past which "aircraft positions from 40 minutes ago"
 * is not degraded service, it is a different and misleading product.
 */

export interface FlightsDegradedProps {
  reason: LiveReason;
  /** The upstream operator, from `connectors.operator_name`. Null when no row exists. */
  operatorName: string | null;
  /** ISO instant of the last good payload, if there ever was one in this process. */
  lastGoodAt: string | null;
  /** Age of that payload in whole seconds at server render time. */
  lastGoodAgeSeconds: number | null;
  /** ISO instant the fixed-window quota clears. Only meaningful for `quota-exhausted`. */
  quotaResetAt: string | null;
  /** True when it is the reader's own per-viewer quota rather than the shared ceiling. */
  perViewerQuota: boolean;
  perUserLimit: number | null;
  windowSeconds: number | null;
}

/** "60 requests per minute" — the window in words, from `connectors.window_seconds`. */
function windowLabel(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "second" : `${seconds} seconds`;
}

export function FlightsDegraded({
  reason,
  operatorName,
  lastGoodAt,
  lastGoodAgeSeconds,
  quotaResetAt,
  perViewerQuota,
  perUserLimit,
  windowSeconds,
}: FlightsDegradedProps) {
  const operator = operatorName ?? "the upstream aggregator";

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-semibold tracking-tight">{TITLE[reason]}</h2>

      <div className="mt-2 space-y-3 text-base leading-relaxed text-foreground-secondary">
        {reason === "upstream-down" || reason === "stale" ? (
          lastGoodAt && lastGoodAgeSeconds !== null ? (
            <p>
              {operator} hasn&rsquo;t answered since{" "}
              <time dateTime={lastGoodAt} className="tabular">
                {formatClockUtc(lastGoodAt)}
              </time>
              , {formatAge(lastGoodAgeSeconds)}. There is nothing recent enough to show, so this
              page is empty rather than out of date.
            </p>
          ) : (
            <p>
              We haven&rsquo;t reached {operator} since this page loaded. There is nothing recent
              enough to show, so this page is empty rather than out of date.
            </p>
          )
        ) : null}

        {reason === "quota-exhausted" ? (
          <p>
            {perViewerQuota && perUserLimit !== null && windowSeconds !== null ? (
              <>
                You&rsquo;ve reached this feed&rsquo;s per-viewer limit of {perUserLimit} requests
                per {windowLabel(windowSeconds)}.
              </>
            ) : (
              <>
                This feed has a shared request ceiling so we stay inside {operator}&rsquo;s
                fair-use limit, and it is currently reached.
              </>
            )}{" "}
            {quotaResetAt ? (
              <>
                It resets at{" "}
                <time dateTime={quotaResetAt} className="tabular">
                  {formatClockUtc(quotaResetAt)}
                </time>
                <Countdown to={quotaResetAt} />.
              </>
            ) : null}
          </p>
        ) : null}

        {reason === "disabled" ? (
          <p>
            We&rsquo;ve disabled this connector. It is not a fault at {operator}&rsquo;s end and
            it is not an outage; it stays off until we turn it back on.
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/*
          NO RETRY BUTTON when the connector is switched off. Retry cannot help, and offering
          it would be a lie about the reader's options (states.md §5.6). The same applies to a
          quota we have not yet cleared: the control is there, but disabled and honest about
          when it will work.
        */}
        {reason === "upstream-down" || reason === "stale" ? <RetryButton /> : null}
        {reason === "quota-exhausted" && quotaResetAt ? (
          <RetryAtButton resetAt={quotaResetAt} />
        ) : null}
        <Button asChild variant="outline" className="h-11">
          <Link href="/live">about our sources</Link>
        </Button>
      </div>
    </div>
  );
}

const TITLE: Record<LiveReason, string> = {
  "upstream-down": "Aircraft positions unavailable",
  stale: "Aircraft positions unavailable",
  "quota-exhausted": "Aircraft positions paused",
  disabled: "Flight tracking is switched off",
};
