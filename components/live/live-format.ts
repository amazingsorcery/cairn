import type { Aircraft, FlightsPayload } from "@/lib/connectors/flights";

/**
 * Shared vocabulary and formatting for the Live surfaces.
 *
 * Everything here is safe in a Client Component: it is types and pure functions, with no
 * import of `lib/connectors/runtime`, which refuses to load in a browser bundle on purpose
 * (a client-side connector call would hand the user's IP and viewport to the upstream —
 * ADR 0011 §1). The two type imports below are `import type`, so they are erased.
 */

export type LiveState = "fresh" | "stale" | "unavailable";
export type LiveReason = "upstream-down" | "stale" | "quota-exhausted" | "disabled";

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
  /** One sentence fit to render. Never an upstream error body. */
  message: string | null;
  connector: string;
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
