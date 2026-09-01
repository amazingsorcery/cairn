import * as React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
 * The surface does not read it. `FlightsEnvelopeDto` has no field for it, `parseEnvelope`
 * drops it, and `quotaResetAt` is a PROP fixed at server render. A reader who meets the
 * refusal mid-session — the only way a reader already on the page can meet it — loses the
 * reset time and the retry control entirely, and is told the cause is the operator's shared
 * fair-use ceiling when it is our own per-client counter.
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
      }}
      initialAgeSeconds={5}
      viewport={{ lat: 51.5, lon: -0.1, radius: 50 }}
      refreshSeconds={5}
      operatorName="adsb.lol"
      // Null because the page rendered healthy. This is the case the finding is about.
      quotaResetAt={null}
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

  /* DEFECT (QA-V4-01). Invert these two when the client carries `quotaResetsAt`. */
  it.fails("renders the reset instant the route went to the trouble of sending", async () => {
    const body = await refuseMidSession();
    expect(body).toMatch(/resets at/i);
  }, 20000);

  it.fails("does not blame the operator's shared ceiling for our own per-client counter", async () => {
    const body = await refuseMidSession();
    expect(body).not.toMatch(/shared request ceiling/i);
  }, 20000);
});
