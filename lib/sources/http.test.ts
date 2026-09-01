import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brand } from "@/config/brand";


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

  /**
   * QV-03. The cap has to bite while the body is arriving. The map's six adapters share this
   * one path with the Toolbench's four connectors, and the finding's own note is that
   * maintaining the two separately "is how one of them ends up with QV-03 fixed and the
   * other not" — so both are asserted, in their own suites, against the same helper.
   */
  it("stops pulling a chunked oversize body instead of buffering it whole", async () => {
    const CAP = 4096;
    const CHUNK = 512;
    let produced = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced >= CAP * 8) {
              controller.close();
              return;
            }
            produced += CHUNK;
            controller.enqueue(new Uint8Array(CHUNK).fill(97));
          },
        }),
        // No content-length: the gate that used to be the only one never fires here.
        { status: 200 },
      ),
    );

    const result = await fetchUpstream({
      slug: "chunked",
      url: "https://example.com",
      signal: signal(),
      maxBytes: CAP,
    });

    expect(result.ok).toBe(false);
    expect(produced).toBeLessThan(CAP * 8);
    expect(produced).toBeLessThanOrEqual(CAP + CHUNK * 4);
  });

  /* ---------------------------------------------------------------- *
   * QV-18 — the redirect pin
   * ---------------------------------------------------------------- */

  it("sends redirect: manual, so a 302 is a decision rather than a request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchUpstream({ slug: "pin", url: "https://example.com/a", signal: signal() });
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("follows a redirect that stays on the host it was pointed at", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/moved" } }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const result = await fetchUpstream({ slug: "hop", url: "https://example.com/a", signal: signal() });

    expect(result.ok).toBe(true);
    // Resolved against the current URL, so a relative Location behaves as a browser would.
    expect(spy.mock.calls[1]?.[0]).toBe("https://example.com/moved");
  });

  /**
   * QA finding QV-18. `fetchUpstream` sent `redirect: "follow"` with no pin at all, in a
   * codebase whose connector primitive four files away says why that is wrong:
   * "'the upstream is trustworthy' is exactly the assumption an SSRF exploits — an open
   * redirect on an otherwise honest service is enough."
   *
   * The exposure was one hop of unearned trust in six named operators, which is small; the
   * reason it is closed rather than argued away is that the cloud metadata endpoint is one
   * `Location:` header from any of them, and the whole deployment is one VPS.
   */
  const OFF_HOST = [
    "https://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "https://evil.example.invalid/",
    // Same registrable domain, different host: a pin is a host pin, not a suffix pin.
    "https://attacker.example.com/",
  ];

  for (const location of OFF_HOST) {
    it(`refuses a redirect to ${location} and makes no second request`, async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
        .mockResolvedValueOnce(new Response("SHOULD NEVER BE REQUESTED", { status: 200 }));

      const result = await fetchUpstream({
        slug: "ssrf",
        url: "https://example.com/a",
        signal: signal(),
      });

      expect(result.ok).toBe(false);
      // One request: the hop was refused rather than followed.
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  it("stops walking a redirect chain rather than following it forever", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "/next" } }));

    const result = await fetchUpstream({ slug: "loop", url: "https://example.com/a", signal: signal() });

    expect(result.ok).toBe(false);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("never sends our User-Agent to an off-host destination", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
      );
    await fetchUpstream({ slug: "ua-leak", url: "https://example.com/a", signal: signal() });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("https://example.com/a");
  });

  it("identifies us on every call, because an upstream that cannot contact us just blocks us", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchUpstream({ slug: "ua", url: "https://example.com", signal: signal() });

    const init = spy.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    // NWS returns 403 to a default agent, so this is a requirement, not a courtesy.
    expect(headers?.["user-agent"]).toBe(sourceUserAgent());
    // From `config/brand.ts`, not the literal. A test that hardcodes the product name is one
    // of the places the conventions §4 names explicitly: a rename would leave this green while the
    // header it guards had changed, which is worse than no assertion.
    expect(sourceUserAgent()).toContain(brand.nameLower);
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
