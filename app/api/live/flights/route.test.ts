import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorEnvelope } from "@/lib/connectors/types";

/**
 * `/api/live/flights` answers a refusal with **429 and a `Retry-After`**, not 200.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * QA finding QV-25 put a rate limiter in front of every connector-bound request. This route
 * kept answering 200 with an envelope, on the reading that ADR 0011 rule 5 requires the
 * surface to say what is wrong rather than hand the client an error boundary.
 *
 * The maintainer ruled: **rule 5 governs the body.** A 429 carrying a renderable
 * `quota-exhausted` envelope satisfies it completely, and the status code is the half that
 * monitoring, a proxy and a CDN can act on. `/map/data/[slug]` already answers 429 for the
 * same condition; two routes answering one condition with two status codes was the
 * inconsistency.
 *
 * The body is asserted as well as the status, because a 429 with an empty body would be the
 * error boundary rule 5 actually forbids.
 */

const runConnector = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ clientSubject: () => "anon" }));
vi.mock("@/lib/connectors", () => ({
  flightsDriver: { slug: "adsb-lol" },
  runConnector: (...args: unknown[]) => runConnector(...args),
}));

function envelope(overrides: Partial<ConnectorEnvelope<unknown>> = {}): ConnectorEnvelope<unknown> {
  return {
    fetchedAt: null,
    state: "unavailable",
    data: null,
    connectorSlug: "adsb-lol",
    attribution: "Aircraft data from adsb.lol, licensed under ODbL 1.0.",
    lastError: "You have made too many requests to our live sources. Try again shortly.",
    reason: "quota-exhausted",
    quotaResetsAt: null,
    // The default fixture is the ENTRY limiter's refusal, which is the one a reader meets
    // first under load and the one QV-29 was rendering as the operator's fair-use ceiling.
    quotaScope: "entry",
    ...overrides,
  };
}

const request = () =>
  new Request("http://127.0.0.1:3200/api/live/flights?lat=51.5&lon=-0.1&radius=50");

beforeEach(() => {
  runConnector.mockReset();
  vi.useRealTimers();
});

describe("GET /api/live/flights", () => {
  it("answers 200 while the source is answering", async () => {
    runConnector.mockResolvedValue(
      envelope({
        state: "fresh",
        reason: null,
        lastError: null,
        fetchedAt: new Date("2026-09-01T08:25:00.000Z"),
        data: { aircraft: [] },
      }),
    );
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
    // No counter refused, so there is no counter to name. A scope on a healthy envelope would
    // be a limit reported to a reader who is not subject to one.
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed.quotaScope).toBeNull();
  });

  it("answers 200 for a source that is switched off — that is a decision, not a limit", async () => {
    runConnector.mockResolvedValue(envelope({ reason: "disabled" }));
    const { GET } = await import("./route");
    const response = await GET(request());
    // 429 would tell a client to back off and try again, which is wrong: the kill-switch is
    // not a rate limit and no amount of waiting clears it.
    expect(response.status).toBe(200);
  });

  it("answers 429 when a quota refused the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T08:25:12.000Z"));
    runConnector.mockResolvedValue(
      envelope({ quotaResetsAt: new Date("2026-09-01T08:26:00.000Z") }),
    );
    const { GET } = await import("./route");
    const response = await GET(request());

    expect(response.status).toBe(429);
    // 48 seconds to the window boundary, rounded up: a client that waits exactly this long
    // finds the counter reset rather than one request short of it.
    expect(response.headers.get("retry-after")).toBe("48");
    expect(response.headers.get("cache-control")).toContain("no-store");

    // THE BODY IS STILL THE ENVELOPE. ADR 0011 rule 5: the surface says what is wrong and
    // how old the data is, and a client that renders `reason` keeps working unchanged.
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed.reason).toBe("quota-exhausted");
    expect(parsed.state).toBe("unavailable");
    expect(parsed.message).toContain("too many requests");
    expect(parsed.attribution).toContain("adsb.lol");

    /*
     * AND WHICH COUNTER REFUSED (QA finding QV-29). Without this the client is left to infer
     * it from the wording of `message`, which is what it did: it matched "You have reached",
     * the entry limiter writes "You have made", and so every refusal from the counter that
     * bites first was rendered as "we are at adsb.lol's fair-use ceiling" — a false statement
     * about a named third party on a path where nothing was asked of them.
     */
    expect(parsed.quotaScope).toBe("entry");
    expect(parsed.quotaResetsAt).toBe("2026-09-01T08:26:00.000Z");
  });

  it("still answers 429 when the reset instant is unknown, without inventing a Retry-After", async () => {
    // `quotaResetsAt` is null when the limiter itself failed and we refused fail-closed. A
    // guessed header would be a number we cannot stand behind.
    runConnector.mockResolvedValue(envelope({ quotaResetsAt: null }));
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("never answers 429 for a refusal THEY made — that is not our limit to advertise", async () => {
    runConnector.mockResolvedValue(envelope({ reason: "rate-limited" }));
    const { GET } = await import("./route");
    const response = await GET(request());
    expect(response.status).toBe(200);
  });
});
