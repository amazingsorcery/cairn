import * as React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `RetryAtButton` calls `useRouter`, and jsdom has no App Router.
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
 * A 429 from `/api/live/flights` that arrives on a client refresh, after the page rendered
 * healthy. The envelope carries `quotaResetsAt` and `quotaScope`; the surface must show the
 * reset time and not blame the operator's shared ceiling for our per-client limit.
 * See also `components/live/flights-quota.test.tsx`.
 *
 * The body below was captured from a real 429 (`retry-after: 18`).
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
  // Which counter refused; `entry` is the per-client limiter in front of `runConnector`.
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
      // Rendered healthy, so no reset instant is known at server render.
      perUserLimit={6}
      windowSeconds={60}
    />,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  return document.body.textContent ?? "";
}

describe("a 429 that arrives on a refresh", () => {
  it("still renders the degraded sentence; a non-2xx does not blank the surface", async () => {
    const body = await refuseMidSession();
    expect(body).toMatch(/Aircraft positions paused/i);
  }, 20000);

  it("renders the reset instant sent by the route", async () => {
    const body = await refuseMidSession();
    expect(body).toMatch(/resets at/i);
  }, 20000);

  it("does not blame the operator's shared ceiling for our own per-client counter", async () => {
    const body = await refuseMidSession();
    expect(body).not.toMatch(/shared request ceiling/i);
  }, 20000);
});
