import { ageSeconds } from "@/components/live/live-format";
import type { SourceFailure } from "@/lib/sources/types";
import type { LayerPayloadDto } from "./registry";

/**
 * WHEN THE MAP MAY ASK A SOURCE AGAIN. Pure decisions, no React, no fetch, no clock of its
 * own — so the thing that has to be right about our outbound rate is testable rather than
 * inferable from a component.
 *
 * Three callers' worth of policy live here:
 *
 *   1. the five-second tick that ages layers out,
 *   2. the `moveend` re-fetch, which used to fire on every pan with no throttle at all,
 *   3. the failure path, which used to stop polling forever after one transient 502.
 *
 * ## The constraint this is written against
 *
 * ADR 0021: adsb.lol publishes no rate limit, was measured refusing around 10 requests a
 * minute, and the registry row gives it a 60 s TTL and a global ceiling of six calls a
 * minute. **Three concurrent viewports is the real ceiling**, so a single reader dragging the
 * map must not be able to spend it. Before this module, `handleViewportChange` called
 * `refreshLayer` for every viewport-scoped layer on every `moveend`; that was harmless only
 * because the server cache was keyed on the source slug and answered any viewport from one
 * entry — which is the defect (QV-04) this lands with. Fixing the key without fixing the pan
 * would have turned one drag into a burst of cold misses.
 */

/** How long after the last `moveend` we treat the reader as having stopped. */
export const VIEWPORT_SETTLE_MS = 500;

/** How often the surface re-evaluates every layer. Not a poll: most ticks decide nothing. */
export const TICK_MS = 5000;

/**
 * The floor between two viewport-driven requests for one layer.
 *
 * ADR 0021's own arithmetic: 30 s is two requests a minute per viewport, which is what the
 * six-a-minute ceiling supports across three concurrent viewports. It is a floor rather than
 * the whole rule — see `viewportGapMs`.
 */
export const VIEWPORT_MIN_GAP_MS = 30_000;

/**
 * The gap this layer's source actually gets: **at most two requests per TTL, and never more
 * than one per 30 seconds.**
 *
 * Deriving it from the TTL rather than fixing it at 30 s keeps the operator in charge. The
 * TTL is a registry column precisely so it can be raised under load without a deploy
 * (ADR 0024), and a constant here would ignore that — an operator who moves adsb.lol to five
 * minutes would still be panned at twice a minute. The 30 s floor keeps a lowered TTL from
 * pushing our own pan rate above what ADR 0021 measured as safe.
 */
export function viewportGapMs(ttlSeconds: number): number {
  return Math.max(VIEWPORT_MIN_GAP_MS, (ttlSeconds * 1000) / 2);
}

/**
 * Which failures are worth asking about again on a timer, and which are not.
 *
 * ## Why this list exists (QA finding QV-15)
 *
 * The tick used to `continue` on **every** failure while its comment said it stopped only for
 * `rateLimited`. One transient 502 and that layer never refreshed again for the life of the
 * page — recoverable only through the retry button, which a reader has no reason to press
 * because nothing tells them the layer has stopped trying. The comment and the code
 * disagreed, and the code was the wrong one.
 *
 * The distinction is not "transient versus permanent". It is **whether asking again is a
 * thing we are entitled to do**:
 *
 *   - `upstreamError`, `timeout`, `schemaChanged` — the upstream is having a moment, or has
 *     changed shape and may change back mid-deploy. Asking again once per TTL costs exactly
 *     what a healthy layer costs, and is the difference between a layer that recovers and one
 *     that is dead until the page is reloaded.
 *   - `rateLimited` — **they** told us to stop. Continuing to call a service that has asked us
 *     not to is the breach product-brief §3.2 constraint 5 forbids, and it is what QA finding
 *     Q-02 was about on `/live/flights`.
 *   - `quotaExhausted` — **we** told ourselves to stop, against the ceiling that keeps us
 *     inside somebody's fair use. Every client retrying on a timer would pin us at that
 *     ceiling, which is the same outcome by a politer route.
 *   - `disabled`, `notConfigured` — an operator's decision and a deployment's configuration.
 *     Neither is answered by asking again; both would only write refusal rows.
 *
 * The retry button remains for all six, because a deliberate press by a reader who can see
 * the failed state is a different act from a timer.
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
 * The whole decision, in one pure function.
 *
 * Every branch that returns a reason is a request that will leave the browser, and every
 * branch that returns null is one that will not. Nothing else in the surface may call
 * `refreshLayer` on a timer or on a gesture without coming through here.
 */
export function refreshReason(input: RefreshInput): RefreshReason | null {
  const { payload, wantedKey, heldKey, lastRequestedAt, now } = input;
  if (!payload) return null;

  /*
   * A failure DTO with no source is the "no adapter for this layer" case: there is nothing
   * configured to call, so there is nothing to ask again. It also has no TTL to pace with.
   */
  if (!payload.source) return null;
  const ttlMs = payload.source.ttlSeconds * 1000;
  const sinceRequest = now - lastRequestedAt;

  if (!payload.ok) {
    if (!isRetryableFailure(payload.failure.kind)) return null;
    /* Paced at the source's own cadence, so a failing layer costs no more than a working one. */
    return sinceRequest >= ttlMs ? "recovery" : null;
  }

  /*
   * THE PAYLOAD ANSWERS A DIFFERENT QUESTION.
   *
   * Not "the reader moved" — the reader can pan a long way inside one grid cell, and can pan
   * any distance at all on a layer that is not viewport-scoped, without changing what we
   * would ask. `wantedKey` and `heldKey` are the same cache keys the server uses, so this
   * compares questions rather than positions and a global feed can never trigger it.
   */
  if (heldKey !== null && heldKey !== wantedKey) {
    return sinceRequest >= viewportGapMs(payload.source.ttlSeconds) ? "viewport" : null;
  }

  /*
   * Two conditions, not one. The age is the reader-facing rule (ADR 0014: the cadence is the
   * source's TTL, never a number chosen in the UI); `sinceRequest` is what stops a payload
   * whose refresh keeps failing from being asked for on every tick.
   */
  if (ageSeconds(payload.observedAt, now) * 1000 < ttlMs) return null;
  return sinceRequest >= ttlMs ? "age" : null;
}

/**
 * A trailing debounce. `notify()` any number of times; `run` happens once, `delayMs` after the
 * last one.
 *
 * This is what makes a drag one request instead of a burst: MapLibre emits `moveend` at the
 * end of every sub-gesture — each flick of an inertial pan, each zoom step — and a five-second
 * drag can produce a dozen of them. Trailing rather than leading, deliberately: the useful
 * viewport is the one the reader stopped on, not the one they passed through.
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
