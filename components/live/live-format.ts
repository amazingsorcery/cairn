import type { Aircraft, FlightsPayload } from "@/lib/connectors/flights";
import type { ConnectorState, DegradedReason, QuotaScope } from "@/lib/connectors/types";

/**
 * Shared types and formatting for the Live surfaces. Client-safe: type-only imports from
 * `lib/connectors`, never `lib/connectors/runtime` (server-only).
 */

/**
 * Aliases of the server unions, so a new server-side member is a compile error in every
 * `Record<LiveReason, …>` here.
 */
export type LiveState = ConnectorState;
export type LiveReason = DegradedReason;
/** Which counter refused, when `reason` is `quota-exhausted`. */
export type LiveQuotaScope = QuotaScope;

/**
 * Every scope as a value, for narrowing wire strings. A `Record` so a new server scope fails
 * to compile here; written out because `lib/connectors/` can't be value-imported client-side.
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
 * The connector envelope as sent to the client, with `fetchedAt` as an ISO string (a `Date`
 * doesn't survive JSON). The age is recomputed from it on every tick.
 */
export type FlightsEnvelopeDto = {
  state: LiveState;
  fetchedAt: string | null;
  data: FlightsPayload | null;
  attribution: string | null;
  reason: LiveReason | null;
  /**
   * One displayable sentence, never an upstream error body. Don't branch on it; use
   * `quotaScope`.
   */
  message: string | null;
  connector: string;
  /**
   * ISO instant the refusing counter clears. On the envelope (not just `Retry-After`) so a
   * refusal that arrives on a client refresh can still show it.
   */
  quotaResetsAt: string | null;
  /** Which of our counters refused. Null for every reason other than `quota-exhausted`. */
  quotaScope: LiveQuotaScope | null;
};

export type { Aircraft, FlightsPayload };

/**
 * `14:32:07 UTC`. Pinned to `en-GB` and UTC so server and client render the same string
 * (no hydration mismatch).
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
 * `8s ago`, `96s ago`, `12 minutes ago`. Seconds are kept up to two minutes because 30s vs
 * 90s matters for an aircraft position.
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

/** `51.5045, -0.1150`, four decimal places. */
export function formatPosition(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/** What to call an aircraft in a list when it broadcasts no callsign. */
export function aircraftLabel(aircraft: Aircraft): string {
  return aircraft.callsign ?? aircraft.registration ?? aircraft.hex.toUpperCase();
}

/**
 * `2026-08-19` for a `<time dateTime>` attribute. Accepts a string too: `unstable_cache`
 * round-trips through JSON, so a `Date` column comes back as a string on a cache hit.
 */
export function isoDay(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}
