import type { Aircraft, FlightsPayload } from "@/lib/connectors/flights";
import type { ConnectorState, DegradedReason, QuotaScope } from "@/lib/connectors/types";

/**
 * Shared vocabulary and formatting for the Live surfaces.
 *
 * Everything here is safe in a Client Component: it is types and pure functions, with no
 * import of `lib/connectors/runtime`, which refuses to load in a browser bundle on purpose
 * (a client-side connector call would hand the user's IP and viewport to the upstream —
 * ADR 0011 §1). The two type imports below are `import type`, so they are erased.
 */

/**
 * ALIASES, not copies.
 *
 * These were hand-written duplicates of the server's own unions, and they silently went out
 * of date the moment `DegradedReason` gained `rate-limited` (QA finding Q-02) — the server
 * started emitting a reason the client had no copy, icon or tone for. Deriving them means the
 * next member added server-side is a compile error in every `Record<LiveReason, …>` map here,
 * which is exactly where a missing icon or missing copy should surface.
 *
 * `lib/connectors/types.ts` holds only types and is safe to import from a Client Component —
 * unlike `lib/connectors/runtime.ts`, which refuses to load in a browser bundle on purpose.
 */
export type LiveState = ConnectorState;
export type LiveReason = DegradedReason;
/**
 * Which counter refused, when `reason` is `quota-exhausted`. Aliased for the same reason as
 * the two above: the server owns the vocabulary and a member added there must be a compile
 * error in every `Record<LiveQuotaScope, …>` here, rather than a wire value the client
 * quietly drops back to a default sentence.
 */
export type LiveQuotaScope = QuotaScope;

/**
 * Every scope, as a value, so a wire string can be narrowed to one.
 *
 * The `Record` is the mechanism, not the array: a fifth scope on the server fails to compile
 * here, which is where a missing sentence should surface. Written out rather than derived
 * from a runtime import because `lib/connectors/` is server-only by design — the type import
 * above is erased, a value import would not be.
 */
const QUOTA_SCOPES: Readonly<Record<LiveQuotaScope, true>> = {
  entry: true,
  viewer: true,
  shared: true,
  unmeasured: true,
};

/** Narrows a value off the wire. Anything unrecognised is `null`, never a guess. */
export function asQuotaScope(value: unknown): LiveQuotaScope | null {
  return typeof value === "string" && Object.hasOwn(QUOTA_SCOPES, value)
    ? (value as LiveQuotaScope)
    : null;
}

/**
 * The connector envelope as it crosses the server/client boundary. It is the envelope from
 * `lib/connectors/types.ts` with `fetchedAt` as an ISO string, because a `Date` does not
 * survive JSON and because ADR 0014 §1 requires the age to be recomputed from `fetchedAt`
 * on every tick rather than baked in at response time.
 */
export type FlightsEnvelopeDto = {
  state: LiveState;
  fetchedAt: string | null;
  data: FlightsPayload | null;
  attribution: string | null;
  reason: LiveReason | null;
  /**
   * One sentence fit to render. Never an upstream error body.
   *
   * IT IS PROSE, AND NOTHING MAY BRANCH ON IT. `flights-surface.tsx` used to decide which of
   * our three quotas had refused by matching the first four words of this string, and the
   * counter that bites first wrote different words — so a reader was told a named operator's
   * fair-use limit was exhausted when nothing had been asked of that operator (QV-29). The
   * discriminator is `quotaScope`; this field is for reading, not for parsing.
   */
  message: string | null;
  connector: string;
  /**
   * ISO instant the refusing counter clears, when one refused. `/api/live/flights` sends it
   * in the body as well as in `Retry-After` precisely so the surface can say "it resets at
   * 13:42" — and it is on the ENVELOPE rather than a prop fixed at server render, because a
   * refusal that arrives on a refresh is the only way a reader already on the page can meet
   * one, and that path had no instant and therefore no control at all.
   */
  quotaResetsAt: string | null;
  /** Which of our counters refused. Null for every reason other than `quota-exhausted`. */
  quotaScope: LiveQuotaScope | null;
};

export type { Aircraft, FlightsPayload };

/**
 * `14:32:07 UTC` — the "as of" clock on every Live surface.
 *
 * Pinned to `en-GB` and UTC so the server and the client render the identical string. A
 * locale-dependent or timezone-dependent clock is both a hydration mismatch and, for an
 * audience that corroborates each other's screenshots, a different number on two screens.
 */
export function formatClockUtc(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

/** Whole seconds between two instants, floored at zero. */
export function ageSeconds(fetchedAt: Date | string, now: number = Date.now()): number {
  const date = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((now - date.getTime()) / 1000));
}

/**
 * `8s ago`, `96s ago`, `12 minutes ago`.
 *
 * Seconds are kept as seconds well past a minute because on this surface the difference
 * between 30 and 90 seconds is the difference between a usable aircraft position and one
 * that has moved a mile and a half. Rounding it to "a minute ago" would hide exactly the
 * thing ADR 0014 exists to show.
 */
export function formatAge(seconds: number): string {
  if (seconds < 120) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

/** `1,234` with tabular grouping. Pinned to `en-GB` for the same reason as the clock. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

/** Feet to metres, rounded to the metre. ADS-B broadcasts feet; the panel shows both. */
export function feetToMetres(feet: number): number {
  return Math.round(feet * 0.3048);
}

/** Knots to km/h, rounded. Same reason. */
export function knotsToKmh(knots: number): number {
  return Math.round(knots * 1.852);
}

/** `51.5045, -0.1150` — five decimal places, the precision ADS-B actually carries. */
export function formatPosition(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** What to call an aircraft in a list when it broadcasts no callsign. */
export function aircraftLabel(aircraft: Aircraft): string {
  return aircraft.callsign ?? aircraft.registration ?? aircraft.hex.toUpperCase();
}

/**
 * `2026-08-19` for a `<time dateTime>` attribute, from either a `Date` or an ISO string.
 *
 * BOTH ARE REAL AT RUNTIME, and the type says only `Date`. Anything read through
 * `unstable_cache` (`lib/queries/cache.ts`) is serialised to JSON on the way in and parsed on
 * the way out, so a `Date` column comes back as a STRING on a cache hit and as a `Date` on a
 * miss — from the same function, with the same TypeScript type. Calling `.toISOString()`
 * directly therefore works on the first render after a deploy and throws on the second, which
 * is about the worst failure schedule available.
 *
 * `components/verification-date.tsx` already accepts `Date | string` for this reason. This is
 * the same tolerance for the raw attribute.
 */
export function isoDay(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}
