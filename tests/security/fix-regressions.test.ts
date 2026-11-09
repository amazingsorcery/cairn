import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";

/**
 * Independent regression checks for the outbound-path security fixes. Intentionally shares
 * no fixtures with `kill-switch.test.ts`, `connector-cache.test.ts` or `upstream-get.test.ts`.
 *
 * Spies on `globalThis.fetch` (the socket), not a driver's `fetch` member, so a driver that
 * calls fetch itself is still caught.
 */

/**
 * A fixed window boundary rather than `new Date()`: `resetAt` is constant within a
 * fixed window, and a per-call `new Date()` made the byte-identity assertions flaky when two
 * calls straddled a millisecond.
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
    slug: "test-connector",
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
 * The kill-switch, against every real driver
 * ------------------------------------------------------------------ */

describe("no real driver reaches a socket while its row is not live", () => {
  /**
   * Every shipped driver, invoked through `runConnector`. Thunks because `ConnectorDriver<P, R>`
   * has no usable common supertype (`P` is contravariant in `fetch`).
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
 * The cache oracle
 * ------------------------------------------------------------------ */

describe("a spent actor cannot tell a cached term from an unknown one", () => {
  const liveRow = () => row({ enabled: true, status: "published", perUserQuota: 2, cacheTtlSeconds: 900 });

  async function harness() {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    const driver: ConnectorDriver<{ q: string }, { answer: string }> = {
      kind: "infrastructure",
      slug: "test-connector",
      // runConnector charges every caller before reading the cache, for every driver.
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
   * Known residual: `quantiseInstant` floors to an epoch-aligned `cacheTtlSeconds` window, so
   * an entry written near the end of one window and hit in the next reports the previous
   * window's start, while a miss reports the current one.
   */
  it("residual: fetchedAt still separates a hit from a miss across a window boundary", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockResolvedValue({ ok: true, count: 1, limit: 99, remaining: 98, resetAt: WINDOW_RESET_AT });
    const driver: ConnectorDriver<{ q: string }, { answer: string }> = {
      kind: "infrastructure",
      slug: "test-connector",
      normalise: (raw) => raw as { q: string },
      cacheKey: (p) => p.q,
      fetch: async (_c, p) => ({ data: { answer: p.q }, upstreamStatus: 200 }),
    };

    // Fake timers: the fresh path stamps `new Date()`. 900 s windows; the victim asks one
    // minute before a boundary, so the entry is valid until 04:14.
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
      // They differ: the residual is still open.
      expect(hit.fetchedAt?.toISOString()).toBe("2026-09-01T03:45:00.000Z");
      expect(miss.fetchedAt?.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Response byte caps
 * ------------------------------------------------------------------ */

describe("which outbound paths are actually capped", () => {
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

  /** Overpass goes through `lib/connectors/upstream.ts` with an 8 MiB cap. */
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

    // Bound is cap + two chunks: the stream's default queue has pulled one ahead.
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

    // 4 MiB cap, same two-chunk bound.
    expect(counter.pulled).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  /** Both use the outbound primitive: `redirect: "manual"` and host re-checked per hop. */
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

    for (const init of seen) {
      expect(init.redirect).toBe("manual");
    }
    expect(seen.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The map cache key
 * ------------------------------------------------------------------ */

describe("the map cache key and the client throttle agree", () => {
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
 * Limits of the contrast guard
 * ------------------------------------------------------------------ */

describe("what app/tokens.contrast.test.ts does and does not guard", () => {
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
   * Known gap: the contrast guard checks the pairs it lists, but nothing forces the matrix to
   * list every surface token, so a new `--*-surface` would go unchecked. Invert this when
   * the guard requires coverage.
   */
  it("GAP: §4.1 does not have to list every surface token the palette defines", () => {
    const listed = listedSurfaces();
    const defined = [...palette("dark").keys()];
    const surfaceish = defined.filter(
      (name) => name.endsWith("-surface") || ["--background", "--card", "--popover", "--muted", "--accent"].includes(name),
    );
    const unlisted = surfaceish.filter((name) => !listed.has(name));
    // Every surface is listed today, but nothing enforces it.
    expect(unlisted).toEqual([]);
    // The guard pins a literal row count:
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
   * Known gap: the opacity rule in `tokens.css` §4.5 is only enforced against
   * `pagination.tsx`, and `filter-controls.tsx` still violates it.
   */
  it("GAP: the opacity rule is enforced against one file, and a named violation still ships", () => {
    const guard = readFileSync(join(process.cwd(), "app", "tokens.contrast.test.ts"), "utf8");
    expect(guard).toContain('"directory", "pagination.tsx"');
    expect(guard).not.toContain("filter-controls");

    const filterControls = readFileSync(
      join(process.cwd(), "components", "directory", "filter-controls.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    // `opacity-60` on the results region while pending (about 2.9:1 on muted ink).
    expect(filterControls).toMatch(/\bopacity-60\b/);
  });

  /** `tokens.css` §4.4's claim about shipped violations must agree with `search-field.tsx`. */
  it("§4.4 does not name a shipped violation that has been fixed", () => {
    const searchField = readFileSync(
      join(process.cwd(), "components", "directory", "search-field.tsx"),
      "utf8",
    );
    const stillViolating = /text-muted-foreground[^"]*">tool</.test(searchField);
    expect(stillViolating).toBe(false);
    expect(searchField).toContain("text-foreground-secondary");

    // The code is clean, so the matrix must say so.
    expect(tokens).not.toContain("ONE SHIPPED VIOLATION:");
    expect(tokens).toContain("No current violations.");
  });
});

/* ------------------------------------------------------------------ *
 * The two copies of the opening viewport
 * ------------------------------------------------------------------ */

describe("the server's INITIAL_BOUNDS and the client's WORLD are one constant written twice", () => {
  /**
   * The page fetches layers for `INITIAL_BOUNDS`; `map-surface.tsx` seeds `answeredKeys` from
   * `WORLD`. If they differ, the client misattributes payloads to the wrong area.
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
