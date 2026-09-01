/**
 * What a server-side Toolbench lookup returns to the browser.
 *
 * Deliberately a plain, browser-safe module with no import from `lib/connectors/` — that
 * package throws on load in a browser bundle by design, and a client component needs these
 * types. The mapping from a `ConnectorEnvelope` to one of these lives on the server side, in
 * `lib/connectors/toolbench.ts`.
 *
 * FOUR OUTCOMES, NOT TWO. A tool that can only say "here is your answer" or "something went
 * wrong" makes the reader guess which of several very different situations they are in, and
 * for this audience the difference between "the archive has no captures of this URL" and
 * "the archive did not answer" is the difference between a finding and a blank. So:
 *
 *   `ok`          — an answer, with the instant it was obtained and the attribution owed.
 *                   May still be `stale`, with the age shown.
 *   `invalid`     — we refused the input and can say exactly why. **Nothing was requested.**
 *   `unavailable` — no answer, with a `reason` the UI renders differently for each case.
 *
 * There is no spinner state in this union on purpose: pending is the client's business and
 * it belongs to `useTransition`, not to a value the server returns.
 */

/**
 * Why there is no answer. Mirrors the connector runtime's degraded vocabulary, restated here
 * so this module stays free of server-only imports.
 *
 *  `disabled`        — an operator switched this source off, or it has no recorded legal
 *                      basis. Not a fault; a decision. No request was made.
 *  `quota-exhausted` — OUR ceiling refused the call. Nothing left the building.
 *  `rate-limited`    — THEIR limiter refused us. We are standing down until it clears.
 *  `upstream-down`   — we called and it failed, timed out, or answered something unusable.
 */
export type LookupFailureReason = "disabled" | "quota-exhausted" | "rate-limited" | "upstream-down";

export type LookupOutcome<T> =
  | {
      readonly status: "ok";
      readonly data: T;
      /** ISO 8601. The instant the upstream answered, not the instant we rendered. */
      readonly fetchedAt: string;
      /** True when this is a cached payload past its TTL, served because a refresh failed. */
      readonly stale: boolean;
      /** Rendered next to the data, never in a footer. Null only when none is owed. */
      readonly attribution: string | null;
      /** Present on a stale answer: one sentence saying why it was not refreshed. */
      readonly note: string | null;
    }
  | {
      readonly status: "invalid";
      /** A sentence naming what is wrong with the input. Safe to render verbatim. */
      readonly message: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: LookupFailureReason;
      readonly message: string;
      readonly attribution: string | null;
    };

/** Convenience for the client: did anything actually leave our server? */
export function madeARequest(outcome: LookupOutcome<unknown>): boolean {
  if (outcome.status === "invalid") return false;
  if (outcome.status === "unavailable") {
    return outcome.reason !== "disabled" && outcome.reason !== "quota-exhausted";
  }
  return true;
}

/** Seconds between an ISO instant and now, floored at zero. For the "as of" label. */
export function ageSeconds(fetchedAt: string, now: number = Date.now()): number {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/** "just now" / "4 minutes ago" / "2 hours ago". Coarse on purpose; precision here is noise. */
export function describeAge(seconds: number): string {
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
