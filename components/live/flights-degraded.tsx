import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Countdown, RetryAtButton, RetryButton } from "./live-controls";
import { formatAge, formatClockUtc, type LiveQuotaScope, type LiveReason } from "./live-format";

/**
 * `/live/flights` when there is nothing recent enough to show. Each failure reason gets its
 * own message: what's wrong, how old the last good data was, and what the reader can do.
 *
 * Past `cache_ttl + stale_while_revalidate` we show nothing rather than old positions.
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
  /** Which counter refused. Null when unknown, in which case the copy blames nobody. */
  quotaScope: LiveQuotaScope | null;
  perUserLimit: number | null;
  windowSeconds: number | null;
}

/**
 * Message for each quota counter. Only the shared ceiling relates to the upstream's fair-use
 * limit; the entry counter refuses before any upstream is involved. `null` gets a sentence
 * that's true for any of our counters.
 *
 * Don't build a possessive from `operator`: it can end in a parenthesis
 * ("adsb.lol (community ADS-B aggregator)").
 */
function quotaSentence(
  scope: LiveQuotaScope | null,
  operator: string,
  perUserLimit: number | null,
  windowSeconds: number | null,
): string {
  switch (scope) {
    case "entry":
      return `You’ve made too many requests to this site’s live sources in a short window, so we stopped before calling anyone. That counter is ours and it spans every live source here; nothing was asked of ${operator}.`;
    case "viewer":
      return perUserLimit !== null && windowSeconds !== null
        ? `You’ve reached this feed’s per-viewer limit of ${perUserLimit} requests per ${windowLabel(windowSeconds)}. That limit is ours to set, and nothing is wrong at the source’s end.`
        : `You’ve reached the per-viewer limit we set for this feed. That limit is ours to set, and nothing is wrong at the source’s end.`;
    case "shared":
      return `This feed has a request ceiling shared by everyone using this site, set to keep us inside the fair-use limit recorded for ${operator}, and it is currently reached.`;
    case "unmeasured":
      return `We could not check our own request counters, so we did not call ${operator} — we stop rather than spend a limit we cannot count. Nothing is wrong at the source’s end.`;
    case null:
      return `A request limit we set has been reached, so this feed is paused. The limit is ours, and nothing is wrong at the source’s end.`;
  }
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
  quotaScope,
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
            {quotaSentence(quotaScope, operator, perUserLimit, windowSeconds)}{" "}
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

        {reason === "rate-limited" ? (
          <p>
            {operator} asked us to slow down, so we stopped. Their limit is theirs to set and we
            respect it; nothing is broken at either end. We&rsquo;ll start again shortly, and
            this page will not keep asking in the meantime.
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
          No retry when disabled (it can't help) or rate-limited (don't invite calls to a
          service that asked us to stop). An uncleared quota gets a disabled retry that says
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
  "rate-limited": "Aircraft positions paused",
  disabled: "Flight tracking is switched off",
  // Rare here since `flightParamsSchema` clamps the viewport; reachable from the Toolbench.
  "bad-request": "That view could not be read",
};
