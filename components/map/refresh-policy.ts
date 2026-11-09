import { ageSeconds } from "@/components/live/live-format";
import type { SourceFailure } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * When the map may ask a source again: TTL expiry, viewport changes and failure recovery.
 * Pure functions (no React, fetch or clock) so the outbound rate is testable.
 *
 * Main constraint: adsb.lol publishes no rate limit but was measured refusing around 10
 * requests/minute; its registry row has a 60 s TTL and a global ceiling of 6 calls/minute.
 * That allows about three concurrent viewports, so one reader dragging the map must not
 * spend it.
 */

/** How long after the last `moveend` we treat the reader as having stopped. */
export const VIEWPORT_SETTLE_MS = 500;

/** How often the surface re-evaluates every layer. Not a poll: most ticks decide nothing. */
export const TICK_MS = 5000;

/**
 * Minimum gap between viewport-driven requests for one layer: 2/minute per viewport, which
 * the 6/minute ceiling supports across three viewports. See `viewportGapMs`.
 */
export const VIEWPORT_MIN_GAP_MS = 30_000;

/**
 * Gap for a source: at most two requests per TTL, never more than one per 30 s. Derived from
 * the TTL (a registry column operators can raise under load), with the 30 s floor so a lower
 * TTL can't push the pan rate past the safe limit.
 */
export function viewportGapMs(ttlSeconds: number): number {
  return Math.max(VIEWPORT_MIN_GAP_MS, (ttlSeconds * 1000) / 2);
}

/**
 * Failures the timer may retry (once per TTL, same cost as a healthy layer):
 *   - `upstreamError`, `timeout`, `schemaChanged`: may recover on their own.
 * Not retried automatically:
 *   - `rateLimited`: the source asked us to stop.
 *   - `quotaExhausted`: our own ceiling; timed retries would just pin it.
 *   - `disabled`, `notConfigured`: retrying can't help.
 *
 * The manual retry button is separate (see `layer-status.tsx`).
 */
const RETRYABLE_FAILURES: ReadonlySet<SourceFailure["kind"]> = new Set([
  "upstreamError",
  "timeout",
  "schemaChanged",
]);

export function isRetryableFailure(kind: SourceFailure["kind"]): boolean {
  return RETRYABLE_FAILURES.has(kind);
}

/** Why the surface would ask again, or null for "leave it alone". */
export type RefreshReason =
  /** The reader is looking at an area this payload does not answer. */
  | "viewport"
  /** The payload has reached its source's TTL. */
  | "age"
  /** The last answer was a failure that asking again might resolve. */
  | "recovery";

export interface RefreshInput {
  /** What is on screen for this layer now. `undefined` before the first payload exists. */
  readonly payload: LayerPayloadDto | undefined;
  /** Cache key of the question the reader's current viewport asks. */
  readonly wantedKey: string;
  /** Cache key of the question the payload on screen answers, or null if unknown. */
  readonly heldKey: string | null;
  /** When we last sent a request for this layer, whatever came back. */
  readonly lastRequestedAt: number;
  readonly now: number;
}

/**
 * The refresh decision. A non-null result means a request will be sent; all automatic
 * refreshes must go through here.
 */
export function refreshReason(input: RefreshInput): RefreshReason | null {
  const { payload, wantedKey, heldKey, lastRequestedAt, now } = input;
  if (!payload) return null;

  /* No source means no adapter for this layer: nothing to call, no TTL. */
  if (!payload.source) return null;
  const ttlMs = payload.source.ttlSeconds * 1000;
  const sinceRequest = now - lastRequestedAt;

  if (!payload.ok) {
    if (!isRetryableFailure(payload.failure.kind)) return null;
    /* Paced at the source TTL, so a failing layer costs no more than a working one. */
    return sinceRequest >= ttlMs ? "recovery" : null;
  }

  /*
   * The payload answers a different query. Compares server cache keys, not positions, so
   * pans within a grid cell or on a global layer don't trigger it.
   */
  if (heldKey !== null && heldKey !== wantedKey) {
    return sinceRequest >= viewportGapMs(payload.source.ttlSeconds) ? "viewport" : null;
  }

  /*
   * Age past the source TTL, and also `sinceRequest`, so a payload whose refresh keeps
   * failing isn't re-requested every tick.
   */
  if (ageSeconds(payload.observedAt, now) * 1000 < ttlMs) return null;
  return sinceRequest >= ttlMs ? "age" : null;
}

/**
 * Trailing debounce: `run` fires once, `delayMs` after the last `notify()`. MapLibre emits
 * `moveend` per sub-gesture, so a drag can produce a dozen; we want the final viewport.
 */
export interface Settler {
  notify: () => void;
  cancel: () => void;
}

export function createSettler(delayMs: number, run: () => void): Settler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    notify: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel,
  };
}
