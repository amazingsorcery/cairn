import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorEnvelope } from "@/lib/connectors/types";

/**
 * `/api/live/flights` answers a quota refusal with 429 and `Retry-After`, like
 * `/map/data/[slug]`. The body is still the renderable envelope, so it's asserted too.
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
    // Default: the entry limiter's refusal, the one hit first under load.
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
    // No counter refused, so no scope.
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed.quotaScope).toBeNull();
  });

  it("answers 200 for a source that is switched off — that is a decision, not a limit", async () => {
    runConnector.mockResolvedValue(envelope({ reason: "disabled" }));
    const { GET } = await import("./route");
    const response = await GET(request());
    // A kill-switch isn't a rate limit; waiting won't clear it.
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
    // 48 s to the window boundary, rounded up.
    expect(response.headers.get("retry-after")).toBe("48");
    expect(response.headers.get("cache-control")).toContain("no-store");

    // The body is still the envelope.
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed.reason).toBe("quota-exhausted");
    expect(parsed.state).toBe("unavailable");
    expect(parsed.message).toContain("too many requests");
    expect(parsed.attribution).toContain("adsb.lol");

    // Which counter refused, so the client doesn't infer it from `message`.
    expect(parsed.quotaScope).toBe("entry");
    expect(parsed.quotaResetsAt).toBe("2026-09-01T08:26:00.000Z");
  });

  it("still answers 429 when the reset instant is unknown, without inventing a Retry-After", async () => {
    // Null when the limiter itself failed and we refused fail-closed.
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
