import * as React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * ADDED BY THE FIX, and it is the fix showing up: the retry control now renders on this path,
 * `RetryAtButton` calls `useRouter`, and jsdom has no App Router mounted. Before the fix this
 * file needed no stub because no control was ever rendered — which was the finding.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

import { FlightsSurface } from "@/components/live/flights-surface";

/**
 * QA v4 — QA-V4-01.
 *
 * `/api/live/flights` answers 429 since the QV-25 fix round, and the route sends the limiter's
 * own reset instant in the body. Its comment states the intent:
 *
 *   "Sent in the body as well as the header so the surface can render 'try again at 08:26'
 *    rather than a bare count, and so the client is not made to parse a header it would
 *    otherwise never read."
 *
 * The surface did not read it. `FlightsEnvelopeDto` had no field for it, `parseEnvelope`
 * dropped it, and `quotaResetAt` was a PROP fixed at server render. A reader who met the
 * refusal mid-session — the only way a reader already on the page can meet it — lost the
 * reset time and the retry control entirely, and was told the cause was the operator's shared
 * fair-use ceiling when it was our own per-client counter.
 *
 * FIXED 2026-09-01 (frontend-engineer). `quotaResetsAt` and a new `quotaScope` now travel on
 * the envelope, `parseEnvelope` narrows both, and the `quotaResetAt` prop is gone — one
 * source for the instant instead of two. The two `it.fails` below are inverted, and this file
 * is otherwise untouched apart from the fixture, which gains `quotaScope` and drops the
 * removed prop, and a `next/navigation` stub the retry control now requires. The engineer-owned regression test is
 * `components/live/flights-quota.test.tsx`, which shares no fixture with this file.
 *
 * Measured live, dev server, one client, one 60 s window: 120 x 200, 10 x 429, body
 * `{"reason":"quota-exhausted","message":"You have made too many requests to our live
 * sources. Try again shortly.","quotaResetsAt":"2026-09-01T13:14:00.000Z"}`,
 * `retry-after: 18`.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Verbatim from the live 429 measured above. */
const REFUSAL_BODY = {
  state: "unavailable",
  fetchedAt: null,
  data: null,
  attribution: null,
  reason: "quota-exhausted",
  message: "You have made too many requests to our live sources. Try again shortly.",
  connector: "adsb-lol",
  quotaResetsAt: "2026-09-01T13:14:00.000Z",
  // Added by the fix: which of the three counters refused. `entry` is the per-client door
  // limiter in front of `runConnector`, which is what the measurement above hit.
  quotaScope: "entry",
};

async function refuseMidSession(): Promise<string> {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(REFUSAL_BODY), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "18" },
      }),
  ) as unknown as typeof fetch;
  vi.useFakeTimers({ shouldAdvanceTime: true });

  render(
    <FlightsSurface
      initial={{
        state: "fresh",
        fetchedAt: "2026-09-01T13:12:00.000Z",
        data: { aircraft: [], reportedTotal: 0, viewport: { lat: 51.5, lon: -0.1, radius: 50 } },
        attribution: "adsb.lol",
        reason: null,
        message: null,
        connector: "adsb-lol",
        quotaResetsAt: null,
        quotaScope: null,
      }}
      initialAgeSeconds={5}
      viewport={{ lat: 51.5, lon: -0.1, radius: 50 }}
      refreshSeconds={5}
      operatorName="adsb.lol"
      // Null because the page rendered healthy. This is the case the finding is about.
      // The prop is gone: the instant travels in the envelope, which is the fix. The refusal
      // below still arrives with no instant known at server render, which was the case.
      perUserLimit={6}
      windowSeconds={60}
    />,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  return document.body.textContent ?? "";
}

describe("QA-V4-01: a 429 that arrives on a refresh", () => {
  it("HELD: the degraded sentence still renders — a non-2xx does not blank the surface", async () => {
    const body = await refuseMidSession();
    expect(body).toMatch(/Aircraft positions paused/i);
  }, 20000);

  /* FIXED (QA-V4-01), inverted in the fix commit. */
  it("renders the reset instant the route went to the trouble of sending", async () => {
    const body = await refuseMidSession();
    expect(body).toMatch(/resets at/i);
  }, 20000);

  it("does not blame the operator's shared ceiling for our own per-client counter", async () => {
    const body = await refuseMidSession();
    expect(body).not.toMatch(/shared request ceiling/i);
  }, 20000);
});
