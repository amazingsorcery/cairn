import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeFailure } from "./adapter";
import {
  cooldownRemaining,
  DEFAULT_COOLDOWN_SECONDS,
  fetchUpstream,
  isRateLimitStatus,
  openCooldown,
  parseRetryAfter,
  requireApiKey,
  resetSourceRuntime,
  sourceUserAgent,
} from "./http";
import { SOURCE_ADAPTERS, findAdapter, unconfiguredAdapters } from "./index";

/**
 * These tests exist because of QA finding Q-02.
 *
 * The connector layer once logged 57 HTTP 429s and one 420 against a free community service —
 * 29% of every outbound call refused — because the TTL was treated as the limit and nothing
 * backed off when the upstream said stop. Everything below is that lesson, asserted.
 */

const signal = () => new AbortController().signal;

beforeEach(() => {
  resetSourceRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

describe("Retry-After parsing", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("reads an HTTP-date, relative to now", () => {
    const now = new Date("2026-08-31T12:00:00Z");
    expect(parseRetryAfter("Mon, 31 Aug 2026 12:00:30 GMT", now)).toBe(30);
  });

  it("treats a date already past as zero rather than as a negative wait", () => {
    const now = new Date("2026-08-31T12:00:00Z");
    expect(parseRetryAfter("Mon, 31 Aug 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("caps an absurd value, so a hostile header cannot disable a layer for a week", () => {
    expect(parseRetryAfter("99999999")).toBe(3600);
  });

  it("returns null for nonsense and for an absent header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("rate-limit statuses", () => {
  it("counts 429 and the Twitter-style 420, and nothing else", () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(420)).toBe(true);
    expect(isRateLimitStatus(503)).toBe(false);
  });
});

describe("cooldown", () => {
  it("blocks the next call for a source that was refused", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "45" } }),
    );

    const first = await fetchUpstream({ slug: "test", url: "https://example.com/a", signal: signal() });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.failure.kind).toBe("rateLimited");
    expect(cooldownRemaining("test")).toBeGreaterThan(0);

    // The point of Q-02: after a refusal we must not call again at all.
    const callsAfterRefusal = vi.mocked(globalThis.fetch).mock.calls.length;
    const second = await fetchUpstream({ slug: "test", url: "https://example.com/a", signal: signal() });
    expect(second.ok).toBe(false);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(callsAfterRefusal);
  });

  it("falls back to a default cooldown when the upstream sends no Retry-After", async () => {
    // Measured 2026-08-31: adsb.lol sends no Retry-After on a 429. This is that case.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 429 }));

    const result = await fetchUpstream({ slug: "silent", url: "https://example.com", signal: signal() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.failure.kind !== "rateLimited") throw new Error("expected rateLimited");
    expect(result.failure.retryAfterSeconds).toBe(DEFAULT_COOLDOWN_SECONDS);
  });

  it("never shortens a cooldown already open", () => {
    const now = new Date("2026-08-31T12:00:00Z");
    openCooldown("s", 300, now);
    openCooldown("s", 5, now);
    // A later, shorter refusal must not let us back in early.
    expect(cooldownRemaining("s", now)).toBe(300);
  });

  it("obeys a Retry-After on a non-429 too, because a header beats a constant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("maintenance", { status: 503, headers: { "retry-after": "30" } }),
    );
    const result = await fetchUpstream({ slug: "503s", url: "https://example.com", signal: signal() });
    expect(result.ok).toBe(false);
    expect(cooldownRemaining("503s")).toBeGreaterThan(0);
  });
});

describe("fetchUpstream failure typing", () => {
  it("never leaks an upstream response body into the failure message", async () => {
    const secret = "<html>internal stack trace: /srv/app/secret.rb:42</html>";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(secret, { status: 500 }));

    const result = await fetchUpstream({ slug: "leaky", url: "https://example.com", signal: signal() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.failure)).not.toContain("secret.rb");
    expect(describeFailure(result.failure)).toBe("upstream error (HTTP 500)");
  });

  it("returns a typed failure instead of throwing on a transport error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    const result = await fetchUpstream({ slug: "down", url: "https://example.com", signal: signal() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("upstreamError");
  });

  it("refuses a payload larger than its cap rather than holding it in the worker", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(5000), { status: 200 }),
    );
    const result = await fetchUpstream({
      slug: "huge",
      url: "https://example.com",
      signal: signal(),
      maxBytes: 100,
    });
    expect(result.ok).toBe(false);
  });

  it("identifies us on every call, because an upstream that cannot contact us just blocks us", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchUpstream({ slug: "ua", url: "https://example.com", signal: signal() });

    const init = spy.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    // NWS returns 403 to a default agent, so this is a requirement, not a courtesy.
    expect(headers?.["user-agent"]).toBe(sourceUserAgent());
    expect(sourceUserAgent()).toContain("cairn");
  });
});

describe("API keys", () => {
  it("names the missing variable rather than throwing", () => {
    // Read through the context env reader, so no test mutates the process environment.
    const result = requireApiKey(() => undefined, "SOURCES_TEST_KEY");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.failure.kind !== "notConfigured") throw new Error("expected notConfigured");
    expect(result.failure.missingEnvVar).toBe("SOURCES_TEST_KEY");
  });

  it("accepts a key supplied through the context", () => {
    const result = requireApiKey((n) => (n === "SOURCES_TEST_KEY" ? " abc " : undefined), "SOURCES_TEST_KEY");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key).toBe("abc");
  });
});

describe("the registry", () => {
  it("gives every adapter a unique slug", () => {
    const slugs = SOURCE_ADAPTERS.map((adapter) => adapter.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives every adapter an attribution with a licence, so the UI cannot forget one", () => {
    // Several of these licences make attribution a CONDITION OF USE. A missing credit is a
    // licence breach, not a polish defect — which is why it is data on the adapter.
    for (const adapter of SOURCE_ADAPTERS) {
      expect(adapter.attribution.text.length).toBeGreaterThan(0);
      expect(adapter.attribution.licence.length).toBeGreaterThan(0);
      expect(adapter.homepage).toMatch(/^https:\/\//);
    }
  });

  it("gives every adapter a TTL of at least ten seconds", () => {
    // product-brief §2b's floor. Anything below it is a poll loop, not a cache.
    for (const adapter of SOURCE_ADAPTERS) {
      expect(adapter.ttlSeconds).toBeGreaterThanOrEqual(10);
    }
  });

  it("finds an adapter by slug and returns undefined for an unknown one", () => {
    expect(findAdapter("usgs-earthquakes")?.kind).toBe("earthquakes");
    expect(findAdapter("no-such-source")).toBeUndefined();
  });

  it("reports a keyed adapter as unconfigured rather than broken when its key is unset", () => {
    const unconfigured = unconfiguredAdapters({});
    expect(unconfigured.map((a) => a.slug)).toContain("nasa-firms");
    expect(unconfiguredAdapters({ FIRMS_MAP_KEY: "abc" }).map((a) => a.slug)).not.toContain(
      "nasa-firms",
    );
  });
});
