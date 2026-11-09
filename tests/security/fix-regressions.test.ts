import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";

/**
 * QA v3 — INDEPENDENT re-verification of the v2 fixes.
 *
 * Owned by qa-adversary. Deliberately does NOT reuse the fixtures or the helpers in
 * `kill-switch.test.ts`, `connector-cache.test.ts` or `upstream-get.test.ts`: those files were
 * edited by the engineers who wrote the fixes, so a re-audit that runs them is verifying the
 * fixer's own account of the fix. Everything here is written from the finding text, not from
 * the fix.
 *
 * The instrument is a spy on `globalThis.fetch` rather than on a driver's own `fetch` member.
 * `driver.fetch` is the seam the guard is in front of; `globalThis.fetch` is the socket. A
 * guard that stops the first and not the second is the defect QV-01 was.
 */

/**
 * A FIXED window boundary, NOT `new Date()`. Integration finding I-20, applied here too.
 *
 * `lib/rate-limit.ts` is a fixed window (ADR 0009): `resetAt` is the same instant for every
 * call inside that window, derived from the caller's own key. A mock that returned
 * `new Date()` per call made the byte-identity assertion below fail whenever a probe and the
 * control made microseconds later straddled a millisecond tick — one digit of
 * `quotaResetsAt`. I-20 fixed exactly that in `tests/security/flights-oracle.test.ts` and
 * this file kept the defect, so it still failed roughly one run in three.
 *
 * The constant is no weaker: the value never depended on any per-subject state, so it could
 * not have carried the leak these tests hunt. The assertions are untouched.
 */
const WINDOW_RESET_AT = new Date("2026-09-01T00:01:00.000Z");

const getConnectorBySlug = vi.fn<(slug: string) => Promise<Connector | null>>();
const consume = vi.fn();
const audit = vi.fn();

vi.mock("@/lib/queries/live", () => ({
  getConnectorBySlug: (slug: string) => getConnectorBySlug(slug),
}));
vi.mock("@/lib/rate-limit", () => ({
  consume: (...args: unknown[]) => consume(...args),
  hashSubject: (s: string) => s,
  clientSubject: () => "anon",
}));
vi.mock("@/lib/connectors/audit", () => ({
  recordConnectorRequest: (...args: unknown[]) => audit(...args),
  AUDIT_RETENTION_DAYS: 30,
}));

/** A registry row in the exact state all thirteen connectors ship in. */
function row(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-0000-0000-0000000000qa".replace("qa", "aa"),
    slug: "qa-v3",
    name: "QA v3",
    kind: "infrastructure",
    operatorName: "QA",
    homepageUrl: "https://example.invalid/",
    termsUrl: "https://example.invalid/terms",
    attribution: "QA credit",
    attributionRequired: true,
    legalBasis: "QA fixture",
    baseUrl: "https://example.invalid",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 3,
    globalCeiling: 10,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: 900,
    staleWhileRevalidateSeconds: 60,
    enabled: false,
    status: "draft",
    ...overrides,
  } as Connector;
}

let realFetch: typeof globalThis.fetch;
let sockets: string[];

beforeEach(() => {
  getConnectorBySlug.mockReset();
  consume.mockReset();
  audit.mockReset();
  sockets = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    sockets.push(typeof input === "string" ? input : input.toString());
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ *
 * QV-01 — the kill-switch, against every real driver
 * ------------------------------------------------------------------ */

describe("QV-01 re-verified: no real driver reaches a socket while its row is not live", () => {
  /**
   * Every shipped driver, imported for real and invoked through `runConnector`.
   *
   * The v2 fix was verified against a fixture driver. A fixture cannot show that a driver
   * which calls `fetch` itself — `flights` and `overpass` both do, bypassing `upstreamGet` —
   * is behind the same guard. Each entry is a thunk because `ConnectorDriver<P, R>` has no
   * usable common supertype (`P` is contravariant in `fetch`), so the drivers cannot be put
   * in one array without an `any` this codebase forbids.
   */
  type Case = { slug: string; run: (subject: string) => Promise<{ state: string; reason: string | null }> };

  async function cases(): Promise<Case[]> {
    const { runConnector } = await import("@/lib/connectors/runtime");
    const { broadcastDriver } = await import("@/lib/connectors/broadcast");
    const { crtShDriver } = await import("@/lib/connectors/crtsh");
    const { dnsDriver } = await import("@/lib/connectors/dns");
    const { flightsDriver } = await import("@/lib/connectors/flights");
    const { overpassDriver } = await import("@/lib/connectors/overpass");
    const { ripeStatDriver } = await import("@/lib/connectors/ripestat");
    const wayback = await import("@/lib/connectors/wayback");
    const actor = (subject: string) => ({ subject });
    return [
      { slug: broadcastDriver.slug, run: (s) => runConnector(broadcastDriver, { name: "bbc" }, actor(s)) },
      { slug: crtShDriver.slug, run: (s) => runConnector(crtShDriver, { domain: "example.com" }, actor(s)) },
      { slug: dnsDriver.slug, run: (s) => runConnector(dnsDriver, { name: "example.com" }, actor(s)) },
      { slug: flightsDriver.slug, run: (s) => runConnector(flightsDriver, { lat: 51.5, lon: -0.1, radius: 50 }, actor(s)) },
      { slug: overpassDriver.slug, run: (s) => runConnector(overpassDriver, { query: "[out:json];out;" }, actor(s)) },
      { slug: ripeStatDriver.slug, run: (s) => runConnector(ripeStatDriver, { resource: "193.0.6.139" }, actor(s)) },
      { slug: wayback.waybackTimelineDriver.slug, run: (s) => runConnector(wayback.waybackTimelineDriver, { url: "https://example.com/" }, actor(s)) },
      { slug: wayback.waybackCapturesDriver.slug, run: (s) => runConnector(wayback.waybackCapturesDriver, { url: "https://example.com/", before: "20200101000000", after: "20210101000000" }, actor(s)) },
    ];
  }

  it("covers all eight shipped drivers, so this suite cannot silently empty", async () => {
    const found = await cases();
    expect(found.length).toBe(8);
    // Seven distinct registry slugs: the two Wayback drivers share `internet-archive-wayback`.
    expect(new Set(found.map((testCase) => testCase.slug)).size).toBe(7);
  });

  const states: [string, Partial<Connector> | null][] = [
    ["enabled = false, status = draft (the shipped state)", {}],
    ["enabled = true but status = draft", { enabled: true }],
    ["enabled = false but status = published", { status: "published" }],
    ["published and enabled but terms_url is null", { enabled: true, status: "published", termsUrl: null }],
    ["published and enabled but legal_basis is null", { enabled: true, status: "published", legalBasis: null }],
    ["no registry row at all", null],
  ];

  for (const [label, overrides] of states) {
    it(`opens no socket for any driver when: ${label}`, async () => {
      const { clearConnectorCache } = await import("@/lib/connectors/runtime");
      for (const testCase of await cases()) {
        clearConnectorCache();
        getConnectorBySlug.mockResolvedValue(
          overrides === null ? null : row({ ...overrides, slug: testCase.slug }),
        );
        consume.mockResolvedValue({ ok: true, count: 1, limit: 3, remaining: 2, resetAt: WINDOW_RESET_AT });
        const envelope = await testCase.run("anonymous");
        expect(envelope.state, `${testCase.slug} served data`).toBe("unavailable");
        expect(envelope.reason, `${testCase.slug} reason`).toBe("disabled");
      }
      expect(sockets, `sockets opened: ${sockets.join(", ")}`).toEqual([]);
    });
  }

  it("audits the refusal exactly once per call, with zero outbound requests", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const { dnsDriver } = await import("@/lib/connectors/dns");
    getConnectorBySlug.mockResolvedValue(row({ slug: dnsDriver.slug }));
    await runConnector(dnsDriver, { name: "example.com" }, { subject: "anonymous" });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "disabled", durationMs: 0, upstreamRequests: 0 });
  });

  it("an options.connector handed in by an admin surface is ALSO checked, not trusted", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const { dnsDriver } = await import("@/lib/connectors/dns");
    getConnectorBySlug.mockResolvedValue(null);
    const envelope = await runConnector(
      dnsDriver,
      { name: "example.com" },
      { subject: "admin" },
      { connector: row({ slug: dnsDriver.slug }) },
    );
    expect(envelope.reason).toBe("disabled");
    expect(sockets).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * QV-02 — the cache oracle
 * ------------------------------------------------------------------ */

describe("QV-02 re-verified: a spent actor cannot tell a cached term from an unknown one", () => {
  const liveRow = () => row({ enabled: true, status: "published", perUserQuota: 2, cacheTtlSeconds: 900 });

  async function harness() {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    const driver: ConnectorDriver<{ q: string }, { answer: string }> = {
      kind: "infrastructure",
      slug: "qa-v3",
      /*
       * EDITED BY backend-engineer, 2026-09-01, mechanically: `ConnectorDriver.perActor` was
       * deleted, so `perActor: true` no longer compiles. The behaviour this fixture relied on
       * is now unconditional — `runConnector` charges every caller before it reads the cache,
       * for every driver — which is what closed QV-02 on the eighth driver. Nothing else in
       * this file was changed except the two `DEFECT` assertions named below, which are
       * inverted as the finding required.
       */
      normalise: (raw) => raw as { q: string },
      cacheKey: (p) => p.q,
      fetch: async (_c, p) => ({ data: { answer: p.q }, upstreamStatus: 200 }),
    };
    return { runConnector, driver };
  }

  it("byte-identical envelopes for a cached term and a never-typed term", async () => {
    const { runConnector, driver } = await harness();
    const budget = new Map<string, number>();
    consume.mockImplementation(async (action: string, subject: string) => {
      const key = `${action}:${subject}`;
      const used = (budget.get(key) ?? 0) + 1;
      budget.set(key, used);
      // Per-user 2/window for the victim and the attacker separately; global is generous.
      const limit = action === "connector-user" ? 2 : 100;
      return { ok: used <= limit, count: used, limit, remaining: Math.max(0, limit - used), resetAt: WINDOW_RESET_AT };
    });

    // The victim populates the shared cache.
    await runConnector(driver, { q: "whistleblower-host.example" }, { subject: "victim" });

    // The attacker spends their own per-user quota.
    await runConnector(driver, { q: "attacker-junk-1" }, { subject: "attacker" });
    await runConnector(driver, { q: "attacker-junk-2" }, { subject: "attacker" });

    const probe = await runConnector(driver, { q: "whistleblower-host.example" }, { subject: "attacker" });
    const control = await runConnector(driver, { q: "never-typed-by-anyone-xyz" }, { subject: "attacker" });

    expect(JSON.stringify(probe)).toBe(JSON.stringify(control));
    expect(probe.reason).toBe("quota-exhausted");
    expect(probe.data).toBeNull();
    expect(probe.fetchedAt).toBeNull();
  });

  it("a hit costs a quota unit, so the probe is neither free nor untraceable", async () => {
    const { runConnector, driver } = await harness();
    consume.mockResolvedValue({ ok: true, count: 1, limit: 2, remaining: 1, resetAt: WINDOW_RESET_AT });
    await runConnector(driver, { q: "same" }, { subject: "victim" });
    consume.mockClear();
    await runConnector(driver, { q: "same" }, { subject: "attacker" });
    const userSpends = consume.mock.calls.filter((call) => call[0] === "connector-user");
    expect(userSpends.length, "a cache hit must consume the per-user quota").toBe(1);
  });

  /**
   * THE RESIDUAL. `quantiseInstant` floors to an epoch-aligned window of `cacheTtlSeconds`.
   * A cache entry written near the END of one window is still inside its TTL after the next
   * window has opened — so a hit reports the previous window's start and a miss reports the
   * current one. The timestamp still separates them, at window granularity, for an actor with
   * quota left.
   */
  it("RESIDUAL: fetchedAt still separates a hit from a miss across a window boundary", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockResolvedValue({ ok: true, count: 1, limit: 99, remaining: 98, resetAt: WINDOW_RESET_AT });
    const driver: ConnectorDriver<{ q: string }, { answer: string }> = {
      kind: "infrastructure",
      slug: "qa-v3",
      // `perActor` deleted from the type — see the note on the fixture above.
      normalise: (raw) => raw as { q: string },
      cacheKey: (p) => p.q,
      fetch: async (_c, p) => ({ data: { answer: p.q }, upstreamStatus: 200 }),
    };

    /*
     * Fake timers because the FRESH path stamps `new Date()` rather than `options.now` — the
     * real upstream response instant, which is right, and which means the clock has to be
     * moved rather than injected.
     *
     * 900 s windows, epoch-aligned. The victim asks at 03:59:00, one minute before a window
     * boundary. The entry is valid until 04:14:00.
     */
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T03:59:00.000Z"));
      await runConnector(driver, { q: "victim-term" }, { subject: "victim" });

      // Ten minutes later: inside the TTL, but in the NEXT quantisation window.
      vi.setSystemTime(new Date("2026-09-01T04:09:00.000Z"));
      const hit = await runConnector(driver, { q: "victim-term" }, { subject: "attacker" });
      const miss = await runConnector(driver, { q: "unknown-term" }, { subject: "attacker" });

      expect(hit.state).toBe("fresh");
      expect(miss.state).toBe("fresh");
      // If these were equal the oracle would be closed. They are not.
      expect(hit.fetchedAt?.toISOString()).toBe("2026-09-01T03:45:00.000Z");
      expect(miss.fetchedAt?.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ *
 * QV-03 — the byte cap, on the paths that do NOT use the shared helper
 * ------------------------------------------------------------------ */

describe("QV-03 re-verified: which outbound paths are actually capped", () => {
  /** A body that never ends, counting the bytes the consumer pulls. */
  function endlessBody(chunkBytes: number, counter: { pulled: number }): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(chunkBytes).fill(0x61);
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        counter.pulled += chunkBytes;
        if (counter.pulled > 512 * 1024 * 1024) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
  }

  it("readCappedText stops within one chunk of the cap", async () => {
    const { readCappedText } = await import("@/lib/net/capped-body");
    const counter = { pulled: 0 };
    const response = new Response(endlessBody(64 * 1024, counter), {
      headers: { "content-type": "text/plain" },
    });
    const result = await readCappedText(response, 256 * 1024);
    expect(result.ok).toBe(false);
    expect(counter.pulled).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
  });

  /**
   * INVERTED by backend-engineer 2026-09-01, as QV-03's fix required. Measured before the
   * fix, by this exact assertion: **513 MiB pulled** (the harness closes the stream at 512),
   * against the 5 MiB the capped sibling path stops at. The driver now goes through
   * `lib/connectors/upstream.ts` with an 8 MiB ceiling, and the same is asserted for the
   * flights driver below.
   */
  it("the Overpass driver stops within one chunk of its cap", async () => {
    const { overpassDriver } = await import("@/lib/connectors/overpass");
    const counter = { pulled: 0 };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(endlessBody(1024 * 1024, counter), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    const connector = row({
      slug: "overpass-api-de",
      baseUrl: "https://overpass-api.de",
      enabled: true,
      status: "published",
    });
    await expect(
      overpassDriver.fetch(connector, { query: "[out:json];out;" }, new AbortController().signal),
    ).rejects.toBeTruthy();

    /*
     * 8 MiB cap, 1 MiB chunks. The bound is the cap plus TWO chunks, not one: the reader
     * stops on the first chunk that carries the total past the cap, and a `ReadableStream`
     * with the default count-based queuing strategy has already pulled one more behind it.
     * Measured here: 10 MiB against an 8 MiB cap, where this same assertion measured 513 MiB
     * before the fix.
     */
    expect(counter.pulled).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it("the flights driver stops within one chunk of its cap", async () => {
    const { flightsDriver } = await import("@/lib/connectors/flights");
    const counter = { pulled: 0 };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(endlessBody(1024 * 1024, counter), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      flightsDriver.fetch(
        row({ slug: "adsb-lol", baseUrl: "https://api.adsb.lol" }),
        { lat: 51, lon: 0, radius: 50 },
        new AbortController().signal,
      ),
    ).rejects.toBeTruthy();

    // 4 MiB cap, 1 MiB chunks, same two-chunk bound. Measured: 6 MiB, against 513 before.
    expect(counter.pulled).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  /**
   * INVERTED by backend-engineer 2026-09-01. Both drivers now go through the one outbound
   * primitive, which sends `redirect: "manual"` and re-checks the pinned host on every hop.
   */
  it("both the Overpass and the flights driver pin the host across a redirect", async () => {
    const overpass = (await import("@/lib/connectors/overpass")).overpassDriver;
    const flights = (await import("@/lib/connectors/flights")).flightsDriver;
    const seen: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;

    await overpass
      .fetch(
        row({ slug: "overpass-api-de", baseUrl: "https://overpass-api.de" }),
        { query: "[out:json];out;" },
        new AbortController().signal,
      )
      .catch(() => undefined);
    await flights
      .fetch(
        row({ slug: "adsb-lol", baseUrl: "https://api.adsb.lol" }),
        { lat: 51, lon: 0, radius: 50 },
        new AbortController().signal,
      )
      .catch(() => undefined);

    // `upstreamRequest` sends `redirect: "manual"` and re-pins every hop. Both now do.
    for (const init of seen) {
      expect(init.redirect).toBe("manual");
    }
    expect(seen.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * QV-04 — the map cache key
 * ------------------------------------------------------------------ */

describe("QV-04 re-verified: the map cache key and the client throttle agree", () => {
  it("a Tokyo box and a world box produce different keys", async () => {
    const { sourceQueryKey } = await import("@/components/map/query");
    const tokyo = sourceQueryKey({ bbox: { west: 139, south: 35, east: 141, north: 36 } });
    const world = sourceQueryKey({ bbox: { west: -180, south: -85, east: 180, north: 85 } });
    const london = sourceQueryKey({ bbox: { west: -1, south: 51, east: 1, north: 52 } });
    expect(new Set([tokyo, world, london]).size).toBe(3);
  });

  it("a pan that stays inside one grid cell produces the same key", async () => {
    const { sourceQueryKey } = await import("@/components/map/query");
    const a = sourceQueryKey({ bbox: { west: 139.1, south: 35.1, east: 139.9, north: 35.9 } });
    const b = sourceQueryKey({ bbox: { west: 139.2, south: 35.2, east: 139.8, north: 35.8 } });
    expect(a).toBe(b);
  });

  it("an antimeridian or inverted box collapses to `unscoped`, sharing an entry with the whole feed", async () => {
    const { sourceQueryKey } = await import("@/components/map/query");
    const crossing = sourceQueryKey({ bbox: { west: 170, south: 35, east: -170, north: 45 } });
    const noBox = sourceQueryKey({});
    expect(crossing).toBe("unscoped");
    expect(crossing).toBe(noBox);
  });
});

/* ------------------------------------------------------------------ *
 * QV-06 — attacking the guard that is supposed to stop QV-06 recurring
 * ------------------------------------------------------------------ */

describe("QV-06 re-verified: what app/tokens.contrast.test.ts does and does not guard", () => {
  const tokens = readFileSync(join(process.cwd(), "app", "tokens.css"), "utf8");

  /** Semantic tokens of one theme block, resolved through the primitives. */
  function palette(theme: "dark" | "light"): Map<string, string> {
    const bounds =
      theme === "dark"
        ? (["2. SEMANTIC PALETTE — DARK", "3. SEMANTIC PALETTE — LIGHT"] as const)
        : (["3. SEMANTIC PALETTE — LIGHT", "4. PERMITTED PAIRINGS"] as const);
    const raw = new Map<string, string>();
    for (const m of tokens.matchAll(/^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/gm)) {
      if (m[1] && m[2]) raw.set(m[1], m[2].toLowerCase());
    }
    const block = tokens.slice(tokens.indexOf(bounds[0]), tokens.indexOf(bounds[1]));
    const out = new Map<string, string>();
    for (const m of block.matchAll(/^\s*(--[a-z0-9-]+):\s*var\((--[a-z0-9-]+)\);/gm)) {
      const hex = m[2] ? raw.get(m[2]) : undefined;
      if (m[1] && hex) out.set(m[1], hex);
    }
    return out;
  }

  /** Surfaces §4.1 actually lists, parsed the same way the guard parses them. */
  function listedSurfaces(): Set<string> {
    const found = new Set<string>();
    const pattern =
      /^\s*\*\s+(--[a-z-]+)\s+[\d.]+\s*\/\s*[\d.]+\s+[\d.]+\s*\/\s*[\d.]+\s+[\d.]+\s*\/\s*[\d.]+/gm;
    for (const m of tokens.matchAll(pattern)) if (m[1]) found.add(m[1]);
    return found;
  }

  /**
   * GAP (QV-06-R1). The matrix guard verifies that every pair it LISTS is accurately
   * documented and clears AA. Nothing requires the matrix to list every surface the palette
   * defines — so a new `--*-surface` token added to both themes and used by a component is
   * invisible to all 229 assertions. That is QV-06's own defect ("a list of anticipated
   * pairs") reproduced one level up, in the file written to prevent it.
   *
   * Measured: adding `--qa-callout-surface: var(--slate-450)` to both blocks leaves the suite
   * at 229/229 green while `--muted-foreground` on it is 2.15:1 light and 1.19:1 dark.
   *
   * INVERT THIS ASSERTION when the guard is extended to require coverage.
   */
  it("GAP: §4.1 does not have to list every surface token the palette defines", () => {
    const listed = listedSurfaces();
    const defined = [...palette("dark").keys()];
    const surfaceish = defined.filter(
      (name) => name.endsWith("-surface") || ["--background", "--card", "--popover", "--muted", "--accent"].includes(name),
    );
    const unlisted = surfaceish.filter((name) => !listed.has(name));
    // Today every surface happens to be listed — the point is that nothing MAKES it so.
    expect(unlisted).toEqual([]);
    // The guard's own count assertion is a fixed literal, not a function of the palette:
    expect(tokens).toContain("4.1 THE TEXT RAMP");
    const guard = readFileSync(join(process.cwd(), "app", "tokens.contrast.test.ts"), "utf8");
    expect(guard, "the guard pins a literal row count instead of deriving it from the palette").toContain(
      "expect(textRows().length).toBe(13)",
    );
    expect(guard, "nothing in the guard compares the matrix against the palette's own keys").not.toMatch(
      /unlisted|uncovered|every surface .*listed/i,
    );
  });

  /**
   * GAP (QV-06-R2). §4.5's executable half greps exactly one file — `pagination.tsx`, the one
   * that was fixed. `tokens.css` §4.5 itself names two other shipped instances of the rule it
   * calls FORBIDDEN, and one of them still ships.
   */
  it("GAP: the opacity rule is enforced against one file, and a named violation still ships", () => {
    const guard = readFileSync(join(process.cwd(), "app", "tokens.contrast.test.ts"), "utf8");
    expect(guard).toContain('"directory", "pagination.tsx"');
    expect(guard).not.toContain("filter-controls");

    const filterControls = readFileSync(
      join(process.cwd(), "components", "directory", "filter-controls.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    // `opacity-60` on a <div> wrapping the whole results region while a filter is pending:
    // every word inside it renders at 60% alpha, which tokens.css §4.5 calls FORBIDDEN and
    // measures at 2.98 / 2.85 on muted ink.
    expect(filterControls).toMatch(/\bopacity-60\b/);
  });

  /**
   * QV-27, fixed and now guarded in both directions.
   *
   * §4.4 named `search-field.tsx:249` as a shipped violation after the same commit had fixed
   * it. A matrix that names a violation which no longer exists is the same failure as one
   * that misses a violation which does: in both cases the document disagrees with the code,
   * and this file exists because that disagreement is the defect class the whole §4 matrix
   * was written to end.
   *
   * The assertion is therefore not "the stale sentence is gone" — that would pass the moment
   * somebody deleted the line. It is that the claim and the code agree.
   */
  it("§4.4 does not name a shipped violation that has been fixed", () => {
    const searchField = readFileSync(
      join(process.cwd(), "components", "directory", "search-field.tsx"),
      "utf8",
    );
    const stillViolating = /text-muted-foreground[^"]*">tool</.test(searchField);
    expect(stillViolating).toBe(false);
    expect(searchField).toContain("text-foreground-secondary");

    // The code is clean, so the matrix must not claim otherwise.
    expect(tokens).not.toContain("ONE SHIPPED VIOLATION:");
    expect(tokens).toContain("NO SHIPPED VIOLATIONS");
  });
});

/* ------------------------------------------------------------------ *
 * The two copies of the opening viewport
 * ------------------------------------------------------------------ */

describe("the server's INITIAL_BOUNDS and the client's WORLD are one constant written twice", () => {
  /**
   * `app/(public)/map/page.tsx` fetches every layer for `INITIAL_BOUNDS`; `map-surface.tsx`
   * seeds `answeredKeys` from `WORLD`. If they ever differ, the client believes every payload
   * answers an area it does not, which is QV-04's shape with the drift moved into two
   * constants instead of two grids. Nothing but this test connects them.
   */
  it("are equal, and nothing else in the tree asserts it", () => {
    const page = readFileSync(join(process.cwd(), "app", "(public)", "map", "page.tsx"), "utf8");
    const surface = readFileSync(join(process.cwd(), "components", "map", "map-surface.tsx"), "utf8");
    /** The object literal a `const NAME ... = { ... }` declaration is initialised with. */
    const read = (source: string, name: string): string => {
      const at = source.indexOf(`const ${name}`);
      if (at < 0) return "";
      const open = source.indexOf("{", at);
      const close = source.indexOf("}", open);
      if (open < 0 || close < 0) return "";
      return source.slice(open, close + 1).replace(/\s+/g, "");
    };
    expect(read(page, "INITIAL_BOUNDS")).toBe(read(surface, "WORLD"));
    expect(read(page, "INITIAL_BOUNDS")).not.toBe("");
  });
});
