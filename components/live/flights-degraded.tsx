import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Countdown, RetryAtButton, RetryButton } from "./live-controls";
import { formatAge, formatClockUtc, type LiveQuotaScope, type LiveReason } from "./live-format";

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
  /**
   * WHICH counter refused. Null when nothing said — in which case the copy blames nobody.
   *
   * This was a boolean, `perViewerQuota`, derived by the surface from the first four words of
   * the server's message. Three counters can refuse, not two, and the guess defaulted to the
   * one branch that makes a claim about a named operator (QV-29).
   */
  quotaScope: LiveQuotaScope | null;
  perUserLimit: number | null;
  windowSeconds: number | null;
}

/**
 * THE SENTENCE FOR EACH COUNTER, CHOSEN BY THE COUNTER (QA finding QV-29).
 *
 * Only ONE of the three ceilings has anything to do with an upstream's fair-use limit, and
 * the shared-ceiling sentence was being shown for all of them — including for the per-client
 * entry counter, which refuses before a registry row is read and therefore cannot be evidence
 * of anything about an operator. Telling a reader that a named third party's limit is
 * exhausted when it is not is the worst copy defect this product has, because not saying
 * things it cannot support is the entire proposition.
 *
 * `null` — nothing said — gets the sentence that is true whichever of our counters refused.
 * The old default was the one that named an operator.
 *
 * NO POSSESSIVE IS BUILT OUT OF THE OPERATOR NAME. `operator` is a registry string and reads
 * "adsb.lol (community ADS-B aggregator)"; the previous copy rendered
 * "adsb.lol (community ADS-B aggregator)’s fair-use limit". `components/map/layer-status.tsx`
 * met the same trap with source names and its tests forbid it.
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
          NO RETRY BUTTON when the connector is switched off. Retry cannot help, and offering
          it would be a lie about the reader's options (states.md §5.6). The same applies to a
          quota we have not yet cleared: the control is there, but disabled and honest about
          when it will work.

          NO RETRY BUTTON when the upstream rate-limited us either, and this one is not about
          honesty but about conduct: a retry control is an invitation to keep calling a service
          that has just asked us to stop. That is the behaviour QA finding Q-02 was about
          (product-brief §3.2 constraint 5). The server holds a cooldown regardless, so the
          button could not work — but it should not be offered in the first place.
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
  // Near-unreachable here: the viewport is clamped by `flightParamsSchema`, not typed by a
  // reader. It is a real state on the Toolbench, where the parameters come from a text field.
  "bad-request": "That view could not be read",
};
