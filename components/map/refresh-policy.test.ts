import { afterEach, describe, expect, it, vi } from "vitest";

import type { LayerPayloadDto } from "./registry";
import {
  TICK_MS,
  VIEWPORT_MIN_GAP_MS,
  VIEWPORT_SETTLE_MS,
  createSettler,
  isRetryableFailure,
  refreshReason,
  viewportGapMs,
} from "./refresh-policy";

/**
 * HOW MANY UPSTREAM CALLS THE MAP CAN MAKE, as arithmetic rather than as a claim.
 *
 * ADR 0021 is the constraint these tests exist to hold: adsb.lol publishes no rate limit, was
 * measured refusing around ten requests a minute, and its registry row gives it a 60 s TTL and
 * a ceiling of six calls a minute — so three concurrent viewports is the real ceiling and one
 * reader dragging the map must not be able to spend it.
 */

const TTL_SECONDS = 60;

function okPayload(observedAt: Date): LayerPayloadDto {
  return {
    layerId: "test-layer",
    source: {
      slug: "test-source",
      name: "Test source",
      homepage: "https://example.invalid/",
      attribution: { text: "Test", licence: "test" },
      ttlSeconds: TTL_SECONDS,
    },
    ok: true,
    features: [],
    observedAt: observedAt.toISOString(),
    stale: false,
  };
}

function failedPayload(kind: "upstreamError" | "rateLimited" | "quotaExhausted"): LayerPayloadDto {
  const failure =
    kind === "upstreamError" ? ({ kind, message: "502 from the origin" } as const) : ({ kind } as const);
  return {
    layerId: "test-layer",
    source: {
      slug: "test-source",
      name: "Test source",
      homepage: "https://example.invalid/",
      attribution: { text: "Test", licence: "test" },
      ttlSeconds: TTL_SECONDS,
    },
    ok: false,
    failure,
    lastGoodAt: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("viewportGapMs", () => {
  it("is two requests per TTL, and never more than one every thirty seconds", () => {
    // ADR 0021's own arithmetic for a 60 s TTL: 2/minute per viewport, three viewports inside
    // the six-a-minute ceiling.
    expect(viewportGapMs(60)).toBe(30_000);
    // An operator raising the TTL under load raises this with it; a constant would ignore them.
    expect(viewportGapMs(300)).toBe(150_000);
    // And lowering the TTL cannot push our pan rate above what ADR 0021 measured as safe.
    expect(viewportGapMs(10)).toBe(VIEWPORT_MIN_GAP_MS);
  });
});

describe("a drag", () => {
  it("makes exactly one upstream call for five seconds of panning", () => {
    vi.useFakeTimers();
    const start = new Date();
    vi.setSystemTime(start);

    const payload = okPayload(start);
    let calls = 0;
    let answeredKey = "0,50,1,51";
    let wantedKey = answeredKey;
    let lastRequestedAt = Date.now() - VIEWPORT_MIN_GAP_MS;

    const settler = createSettler(VIEWPORT_SETTLE_MS, () => {
      const reason = refreshReason({
        payload,
        wantedKey,
        heldKey: answeredKey,
        lastRequestedAt,
        now: Date.now(),
      });
      if (reason === null) return;
      calls += 1;
      lastRequestedAt = Date.now();
      answeredKey = wantedKey;
    });

    /*
     * Twelve `moveend` events over five seconds — MapLibre emits one at the end of every
     * sub-gesture of an inertial drag, and each one lands the reader in a different grid cell.
     * Before the throttle this was twelve requests; the cache answering all of them from one
     * entry was the only thing keeping it inside the ceiling, and that entry was the defect.
     */
    for (let step = 0; step < 12; step += 1) {
      wantedKey = `${step},50,${step + 1},51`;
      settler.notify();
      vi.advanceTimersByTime(420);
    }
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS);

    expect(calls).toBe(1);
    expect(answeredKey).toBe("11,50,12,51");
  });

  it("makes no call at all when it ends where it started", () => {
    vi.useFakeTimers();
    const start = new Date();
    vi.setSystemTime(start);

    const payload = okPayload(start);
    let calls = 0;
    const settler = createSettler(VIEWPORT_SETTLE_MS, () => {
      const reason = refreshReason({
        payload,
        /* A pan inside one grid cell, or any pan at all on a global layer, asks the same
           question — so there is nothing to ask. */
        wantedKey: "unscoped",
        heldKey: "unscoped",
        lastRequestedAt: Date.now() - 10 * 60_000,
        now: Date.now(),
      });
      if (reason !== null) calls += 1;
    });

    for (let step = 0; step < 8; step += 1) {
      settler.notify();
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS);
    expect(calls).toBe(0);
  });
});

describe("refreshReason", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  const fresh = okPayload(new Date(now - 5_000));

  it("asks again when the reader is looking somewhere this payload does not answer", () => {
    expect(
      refreshReason({
        payload: fresh,
        wantedKey: "139,35,141,36",
        heldKey: "-1,51,1,52",
        lastRequestedAt: now - VIEWPORT_MIN_GAP_MS,
        now,
      }),
    ).toBe("viewport");
  });

  it("waits out the gap rather than turning a second pan into a second call", () => {
    expect(
      refreshReason({
        payload: fresh,
        wantedKey: "139,35,141,36",
        heldKey: "-1,51,1,52",
        lastRequestedAt: now - 5_000,
        now,
      }),
    ).toBeNull();

    /* And the tick after the gap expires picks it up, without the reader touching anything. */
    expect(
      refreshReason({
        payload: fresh,
        wantedKey: "139,35,141,36",
        heldKey: "-1,51,1,52",
        lastRequestedAt: now - VIEWPORT_MIN_GAP_MS - TICK_MS,
        now,
      }),
    ).toBe("viewport");
  });

  it("leaves a payload alone until it reaches its source's TTL", () => {
    const older = okPayload(new Date(now - (TTL_SECONDS - 1) * 1000));
    expect(
      refreshReason({ payload: older, wantedKey: "k", heldKey: "k", lastRequestedAt: 0, now }),
    ).toBeNull();

    const due = okPayload(new Date(now - TTL_SECONDS * 1000));
    expect(
      refreshReason({ payload: due, wantedKey: "k", heldKey: "k", lastRequestedAt: 0, now }),
    ).toBe("age");
  });

  it("does not re-request an ageing payload whose refresh just failed", () => {
    /*
     * A payload past its TTL whose refresh keeps failing keeps its old `observedAt`, so the
     * age test stays true. Without the request clock this would fire on every five-second
     * tick — twelve calls a minute at a source we are allowed six.
     */
    const due = okPayload(new Date(now - 10 * 60_000));
    expect(
      refreshReason({
        payload: due,
        wantedKey: "k",
        heldKey: "k",
        lastRequestedAt: now - 2 * TICK_MS,
        now,
      }),
    ).toBeNull();
  });

  it("recovers from a transient upstream failure instead of stopping forever", () => {
    /*
     * QV-15. The tick used to `continue` on every failure while its comment claimed it stopped
     * only for `rateLimited`, so one 502 ended that layer's auto-refresh for the life of the
     * page.
     */
    const failed = failedPayload("upstreamError");
    expect(
      refreshReason({
        payload: failed,
        wantedKey: "k",
        heldKey: "k",
        lastRequestedAt: now - TTL_SECONDS * 1000,
        now,
      }),
    ).toBe("recovery");

    /* Paced at the source's own cadence, so a failing layer costs no more than a working one. */
    expect(
      refreshReason({
        payload: failed,
        wantedKey: "k",
        heldKey: "k",
        lastRequestedAt: now - 5_000,
        now,
      }),
    ).toBeNull();
  });

  it("never re-asks a source that refused us, or one we refused ourselves", () => {
    for (const kind of ["rateLimited", "quotaExhausted"] as const) {
      expect(
        refreshReason({
          payload: failedPayload(kind),
          wantedKey: "k",
          heldKey: "k",
          lastRequestedAt: 0,
          now,
        }),
        kind,
      ).toBeNull();
    }
    expect(isRetryableFailure("rateLimited")).toBe(false);
    expect(isRetryableFailure("quotaExhausted")).toBe(false);
    expect(isRetryableFailure("disabled")).toBe(false);
    expect(isRetryableFailure("notConfigured")).toBe(false);
  });

  it("decides nothing for a layer with no payload and no configured source", () => {
    expect(
      refreshReason({ payload: undefined, wantedKey: "k", heldKey: null, lastRequestedAt: 0, now }),
    ).toBeNull();

    const noAdapter: LayerPayloadDto = {
      layerId: "test-layer",
      source: null,
      ok: false,
      failure: { kind: "notConfigured", missingEnvVar: "an adapter" },
      lastGoodAt: null,
    };
    expect(
      refreshReason({ payload: noAdapter, wantedKey: "k", heldKey: null, lastRequestedAt: 0, now }),
    ).toBeNull();
  });
});
