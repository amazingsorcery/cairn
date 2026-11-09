import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Retry controls call `router.refresh()`; jsdom has no App Router, so it's stubbed. These
 * tests only check that the control exists and says when it will work.
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

import { FlightsDegraded } from "./flights-degraded";
import { FlightsSurface } from "./flights-surface";
import type { FlightsEnvelopeDto } from "./live-format";

/**
 * Quota refusals (429 from `/api/live/flights`):
 * 1. The message names the counter that refused, driven by `quotaScope`.
 * 2. The message never depends on the server's `message` prose.
 * 3. The reset instant and retry control survive a refusal that arrives mid-session.
 */

/* ------------------------------------------------------------------ *
 * The sentence per counter
 * ------------------------------------------------------------------ */

function renderDegraded(props: Partial<React.ComponentProps<typeof FlightsDegraded>> = {}) {
  const { container } = render(
    <FlightsDegraded
      reason="quota-exhausted"
      operatorName="adsb.lol (community ADS-B aggregator)"
      lastGoodAt={null}
      lastGoodAgeSeconds={null}
      quotaResetAt="2026-09-01T13:42:00.000Z"
      quotaScope="entry"
      perUserLimit={6}
      windowSeconds={60}
      {...props}
    />,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

describe("a quota refusal names the counter that actually refused", () => {
  it("does not claim the operator's fair-use limit when OUR entry counter refused", () => {
    const text = renderDegraded({ quotaScope: "entry" });
    // The entry limiter refuses before the upstream is involved.
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).not.toMatch(/fair-use/i);
    expect(text).toMatch(/counter is ours/i);
  });

  it("still says 'shared ceiling' when the shared ceiling is genuinely what refused", () => {
    // When `connector-global` refused, this sentence is correct.
    const text = renderDegraded({ quotaScope: "shared" });
    expect(text).toMatch(/shared/i);
    expect(text).toMatch(/fair-use/i);
  });

  it("names the reader's own per-viewer limit, with its real number", () => {
    const text = renderDegraded({ quotaScope: "viewer" });
    expect(text).toMatch(/per-viewer limit of 6 requests per minute/i);
    expect(text).not.toMatch(/fair-use/i);
  });

  it("says we could not count rather than inventing a culprit", () => {
    // Fail-closed: the limiter was unreachable, so no reset time is known.
    const text = renderDegraded({ quotaScope: "unmeasured", quotaResetAt: null });
    expect(text).toMatch(/could not check/i);
    expect(text).not.toMatch(/fair-use/i);
  });

  it("blames nobody when no scope crossed the wire", () => {
    // Older server or unparseable body: the default must be true for any of our counters.
    const text = renderDegraded({ quotaScope: null });
    expect(text).not.toMatch(/fair-use/i);
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).toMatch(/limit is ours/i);
  });

  it("builds no possessive out of an operator name that ends in a parenthesis", () => {
    // e.g. "adsb.lol (community ADS-B aggregator)’s".
    for (const scope of ["entry", "viewer", "shared", "unmeasured", null] as const) {
      const text = renderDegraded({ quotaScope: scope });
      expect(text, `${scope ?? "null"} scope`).not.toMatch(/\)['’]s/);
    }
  });
});

describe("the sentence is chosen by the counter, never by the prose", () => {
  const OPERATOR = "adsb.lol";

  it("gives different sentences for different counters", () => {
    const scopes = ["entry", "viewer", "shared", "unmeasured"] as const;
    const sentences = scopes.map((scope) =>
      renderDegraded({ quotaScope: scope, operatorName: OPERATOR, quotaResetAt: null }),
    );
    expect(new Set(sentences).size).toBe(scopes.length);
  });

  it("reads no message prose in the surface at all", () => {
    /*
     * Nothing in the surface may branch on `message` text. Comments are stripped first so
     * a comment mentioning the old approach doesn't trip the check.
     */
    const source = readFileSync(join(process.cwd(), "components/live/flights-surface.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(source).not.toMatch(/message\s*\??\.\s*(startsWith|includes|match|indexOf)/);
    expect(source).not.toMatch(/isPerViewerQuota/);
    // And the code that remains must still be the code that renders the surface.
    expect(source).toMatch(/quotaScope=\{envelope\.quotaScope\}/);
  });
});

/* ------------------------------------------------------------------ *
 * The refusal that arrives on a refresh
 * ------------------------------------------------------------------ */

/** A real 429 body from the entry limiter (captured from the dev server, `retry-after: 35`). */
const REFUSAL_BODY = {
  state: "unavailable",
  fetchedAt: null,
  data: null,
  attribution: null,
  reason: "quota-exhausted",
  message: "You have made too many requests to our live sources. Try again shortly.",
  connector: "adsb-lol",
  quotaResetsAt: "2026-09-01T13:42:00.000Z",
  quotaScope: "entry",
};

const HEALTHY: FlightsEnvelopeDto = {
  state: "fresh",
  fetchedAt: "2026-09-01T13:41:00.000Z",
  data: { aircraft: [], reportedTotal: 0, viewport: { lat: 51.5, lon: -0.1, radius: 50 } },
  attribution: "adsb.lol",
  reason: null,
  message: null,
  connector: "adsb-lol",
  quotaResetsAt: null,
  quotaScope: null,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Renders a healthy surface, then lets its own poll meet the captured 429. */
async function refuseMidSession(body: Record<string, unknown> = REFUSAL_BODY): Promise<string> {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "35" },
      }),
  ) as unknown as typeof fetch;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-01T13:41:10.000Z"));

  render(
    <FlightsSurface
      initial={HEALTHY}
      initialAgeSeconds={10}
      viewport={{ lat: 51.5, lon: -0.1, radius: 50 }}
      refreshSeconds={5}
      operatorName="adsb.lol"
      perUserLimit={6}
      windowSeconds={60}
    />,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

describe("a 429 that arrives on a refresh keeps its instant and its control", () => {
  it("still renders a designed state rather than blanking the surface", async () => {
    expect(await refuseMidSession()).toMatch(/Aircraft positions paused/i);
  }, 20000);

  it("renders the reset instant the route went to the trouble of sending", async () => {
    const text = await refuseMidSession();
    expect(text).toMatch(/It resets at/i);
    expect(text).toMatch(/13:42:00 UTC/);
  }, 20000);

  it("offers the retry control the degraded state promises", async () => {
    await refuseMidSession();
    // Present but disabled until the window clears.
    const button = screen.getByRole("button", { name: /retry at 13:42/i });
    expect(button).toBeDisabled();
  }, 20000);

  it("does not blame the operator's shared ceiling for our own entry counter", async () => {
    const text = await refuseMidSession();
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).not.toMatch(/fair-use/i);
  }, 20000);

  it("renders the same sentence whatever prose the server put in `message`", async () => {
    // Two 429s that differ only in `message` must render identically.
    const asSent = await refuseMidSession();
    cleanup();
    const reworded = await refuseMidSession({
      ...REFUSAL_BODY,
      message: "You have reached the limit. Some future author reworded this sentence.",
    });
    expect(reworded).toBe(asSent);
  }, 30000);
});
