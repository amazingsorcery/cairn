import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The retry controls call `router.refresh()` — a server round trip through `runConnector`,
 * never a client fetch to the upstream (ADR 0011 §1). jsdom has no App Router mounted, so
 * the hook is stubbed. Nothing here asserts on navigation; what is asserted is that the
 * control EXISTS and is honest about when it will work.
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
 * QA finding QV-29 — the regression test, written before the fix and watched fail.
 *
 * ## What was wrong, in one line
 *
 * `/api/live/flights` answers **429** with the refusing counter's own reset instant in the
 * body. The client dropped that instant, and it decided WHICH of our three counters had
 * refused by matching the first four words of the sentence the server put in `message`.
 * `isPerViewerQuota` tested `message.startsWith("You have reached")`; the counter that
 * actually bites first — the per-client entry limiter in front of `runConnector` — says
 * "You have made". So the reader was shown the OTHER branch:
 *
 *   > This feed has a shared request ceiling so we stay inside adsb.lol's fair-use limit,
 *   > and it is currently reached.
 *
 * measured verbatim from the rendered DOM of `/live/flights` on 2026-09-01 while
 * `connector-entry` stood at 120 in its window and `connector-global` at 0. adsb.lol's
 * fair-use limit was not reached, nothing had been asked of adsb.lol at all, and this
 * product's whole claim is that it does not say things it cannot support.
 *
 * ## The three things asserted here, and why each is a separate test
 *
 * 1. **The sentence names the counter that actually refused.** Driven by `quotaScope` on the
 *    envelope, which is the discriminator the server already had and did not send.
 * 2. **The sentence does not depend on the prose.** Same scope + different message must give
 *    the same sentence; same message + different scope must give different ones. Fixing this
 *    by matching a different prefix would be the same fragile mechanism one word later, and
 *    this test is what forbids it.
 * 3. **The reset instant and the retry control survive a refusal that arrives mid-session.**
 *    That is the only way a reader already on the page can meet this state, and it was the
 *    one path with no control at all — while `flights-degraded.tsx` says in its own comment
 *    that "the control is there, but disabled and honest about when it will work".
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

describe("QV-29: a quota refusal names the counter that actually refused", () => {
  it("does not claim the operator's fair-use limit when OUR entry counter refused", () => {
    const text = renderDegraded({ quotaScope: "entry" });
    // The false half. Nothing was asked of the operator on this path: the entry limiter sits
    // in front of `runConnector` and refuses before the registry row is even read.
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).not.toMatch(/fair-use/i);
    expect(text).toMatch(/counter is ours/i);
  });

  it("still says 'shared ceiling' when the shared ceiling is genuinely what refused", () => {
    // The fix must not be "delete the sentence". When `connector-global` is the counter that
    // bit, that sentence is true and is the one an operator needs to read.
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
    // `unmeasured` is the fail-closed path: the limiter itself was unreachable, so we refused
    // without calling anyone and without knowing when it clears.
    const text = renderDegraded({ quotaScope: "unmeasured", quotaResetAt: null });
    expect(text).toMatch(/could not check/i);
    expect(text).not.toMatch(/fair-use/i);
  });

  it("blames nobody when no scope crossed the wire", () => {
    /*
     * An older server, or a body we could not narrow. The default must be a sentence that is
     * true whichever of our counters refused — the old default was the one that blamed a
     * named third party.
     */
    const text = renderDegraded({ quotaScope: null });
    expect(text).not.toMatch(/fair-use/i);
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).toMatch(/limit is ours/i);
  });

  it("builds no possessive out of an operator name that ends in a parenthesis", () => {
    // Rendered live before the fix: "adsb.lol (community ADS-B aggregator)’s fair-use limit".
    for (const scope of ["entry", "viewer", "shared", "unmeasured", null] as const) {
      const text = renderDegraded({ quotaScope: scope });
      expect(text, `${scope ?? "null"} scope`).not.toMatch(/\)['’]s/);
    }
  });
});

describe("QV-29: the sentence is chosen by the counter, never by the prose", () => {
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
     * The mechanism, not just its output. `isPerViewerQuota` matched a four-word prefix of a
     * sentence written in `lib/connectors/runtime.ts`; matching a DIFFERENT prefix would have
     * been the same defect one word later. Nothing in this surface may branch on `message`.
     *
     * Comments are stripped first, deliberately: the file carries a tombstone quoting the old
     * call verbatim so the next author knows why it is not coming back, and a guard that
     * forbids describing the defect would delete its own explanation.
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

/**
 * Captured verbatim from the dev server on 2026-09-01, driving the entry limiter to its
 * ceiling with 150 parallel GETs against `/api/live/flights` (97 x 200, 53 x 429) with the
 * `adsb-lol` row left `enabled = false`, so no request reached adsb.lol at any point:
 *
 *   HTTP/1.1 429 Too Many Requests
 *   retry-after: 35
 *   {"state":"unavailable","fetchedAt":null,"data":null,"attribution":null,
 *    "reason":"quota-exhausted",
 *    "message":"You have made too many requests to our live sources. Try again shortly.",
 *    "connector":"adsb-lol","quotaResetsAt":"2026-09-01T13:42:00.000Z","quotaScope":"entry"}
 *
 * `quotaScope` is the field this fix adds; everything else is the body as it was measured.
 */
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

describe("QV-29: a 429 that arrives on a refresh keeps its instant and its control", () => {
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
    // Disabled until the window clears — present and honest about when it will work, which
    // is what `flights-degraded.tsx` documents and what the client path did not do.
    const button = screen.getByRole("button", { name: /retry at 13:42/i });
    expect(button).toBeDisabled();
  }, 20000);

  it("does not blame the operator's shared ceiling for our own entry counter", async () => {
    const text = await refuseMidSession();
    expect(text).not.toMatch(/shared request ceiling/i);
    expect(text).not.toMatch(/fair-use/i);
  }, 20000);

  it("renders the same sentence whatever prose the server put in `message`", async () => {
    /*
     * The property, measured end to end rather than argued from the source: two 429s that
     * differ ONLY in `message` must read identically. `isPerViewerQuota` failed exactly this
     * — it turned a change of wording into a change of who was blamed.
     */
    const asSent = await refuseMidSession();
    cleanup();
    const reworded = await refuseMidSession({
      ...REFUSAL_BODY,
      message: "You have reached the limit. Some future author reworded this sentence.",
    });
    expect(reworded).toBe(asSent);
  }, 30000);
});
