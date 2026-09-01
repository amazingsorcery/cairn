import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";

/**
 * EVERY REQUEST THAT CAN REACH AN UPSTREAM CROSSES ONE COUNTER, AND THE COUNTER IS INSIDE
 * `runConnector`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QA finding QV-25
 * ─────────────────────────────────────────────────────────────────────────────
 * QV-05 was closed on `/map` — 20 page views went from 120 audit rows to 6, and the
 * `map-layer` limiter refuses at exactly 240/60 s. None of it reached the Toolbench. QA
 * measured, against the shipped `enabled = false, status = 'draft'` registry:
 *
 *   100 x POST /toolbench/broadcast-finder/search -> 100 connector_requests, 0 rate_limits
 *   100 x GET  /api/live/flights                  -> 100 connector_requests, 0 rate_limits
 *
 * Six Toolbench entry points and one API route, unauthenticated and unlimited, each writing
 * a row into "the only table in the schema with no natural bound".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE LIMITER IS NOT AT THE ENTRY POINTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The obvious fix — `consumeSafely("toolbench", clientSubject(request))` at the top of each
 * route handler and each action — is the shape QA's closing note warns about: a helper every
 * path is *expected* to call. Seven call sites today, and the eighth surface is written by
 * somebody who has not read this file.
 *
 * So the counter sits inside `runConnector`, which every path must cross because it is the
 * only exported way to reach a driver, and this file asserts BOTH halves of that claim:
 *
 *   1. the inventory half — the set of files under `app/` that can reach `lib/connectors/`
 *      is exactly the list below, and every one of them reaches it through `runConnector`
 *      rather than by calling a driver's `fetch` or the outbound primitive directly;
 *   2. the behavioural half — `runConnector` consumes `connector-entry` before it reads the
 *      registry, before the cache, before the audit log and before any socket, and refuses
 *      identically for two different questions when the budget is spent.
 *
 * Neither half is worth much alone. Together they say: there is one door, and the door
 * counts.
 */

const ROOT = process.cwd();
const APP = join(ROOT, "app");

/**
 * Every file under `app/` that may reach `lib/connectors/`, what it is, and who may call it.
 *
 * Adding a surface that talks to a connector means adding a line here — which is the point.
 * A new entry point is a decision about unauthenticated outbound traffic on somebody else's
 * fair-use ceiling, and it should cost a reviewer's attention rather than a silent import.
 */
type Entry = {
  /** What the surface is and who may reach it. */
  readonly note: string;
  /**
   * `outbound` — this file can cause a request to leave the building, so it must go through
   * `runConnector` and therefore through the entry counter.
   * `constants` — it imports a value from `lib/connectors/` (a retention period, a type) and
   * can reach no upstream at all. It must NOT import a driver or `runConnector`, which is
   * what keeps this category honest.
   */
  readonly reaches: "outbound" | "constants";
};

const INVENTORY: Readonly<Record<string, Entry>> = {
  "api/live/flights/route.ts": {
    note: "GET, anonymous. The refresh tick behind /live/flights.",
    reaches: "outbound",
  },
  "(public)/live/flights/page.tsx": {
    note: "Server Component, anonymous. The first render of /live/flights.",
    reaches: "outbound",
  },
  "(public)/toolbench/broadcast-finder/search/route.ts": {
    note: "POST, anonymous. Radio Browser.",
    reaches: "outbound",
  },
  "(public)/toolbench/overpass-builder/query/route.ts": {
    note: "POST, anonymous. Overpass API.",
    reaches: "outbound",
  },
  "(public)/toolbench/certificate-transparency/actions.ts": {
    note: "Server Action, anonymous. crt.sh.",
    reaches: "outbound",
  },
  "(public)/toolbench/dns-lookup/actions.ts": {
    note: "Server Action, anonymous. Cloudflare DoH.",
    reaches: "outbound",
  },
  "(public)/toolbench/ip-intelligence/actions.ts": {
    note: "Server Action, anonymous. RIPEstat.",
    reaches: "outbound",
  },
  "(public)/toolbench/wayback-explorer/actions.ts": {
    note: "Server Action, anonymous. Wayback CDX and captures.",
    reaches: "outbound",
  },
  "admin/connectors/page.tsx": {
    note: "Server Component, signed-in admin (middleware matches /admin/:path*). Reads the " +
      "registry and the audit board; imports AUDIT_RETENTION_DAYS and nothing that calls out.",
    reaches: "constants",
  },
};

/**
 * Imports that reach a driver or the outbound primitive without passing `runConnector`.
 *
 * `toLookupOutcome` and `invalidInput` live in `lib/connectors/toolbench.ts` too and are
 * envelope mapping, not outbound anything, so the test is on the identifier rather than on
 * the module path.
 */
const BYPASS_IDENTIFIERS = ["upstreamGet", "upstreamRequest", "readCappedText"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Files under `app/` whose source imports anything from `@/lib/connectors`. */
function entryPoints(): string[] {
  return walk(APP)
    .filter((file) => /from\s+["']@\/lib\/connectors/.test(readFileSync(file, "utf8")))
    .map((file) => relative(APP, file).split(sep).join("/"))
    .sort();
}

describe("QV-25: the inventory of surfaces that can reach a connector", () => {
  it("is exactly the declared list — a new one fails this test rather than shipping quietly", () => {
    expect(entryPoints()).toEqual(Object.keys(INVENTORY).sort());
  });

  it("every one of them goes through runConnector, and none reaches the socket another way", () => {
    for (const [file, entry] of Object.entries(INVENTORY)) {
      /*
       * Comments removed first. `wayback-explorer/actions.ts` documents `upstreamGet`'s
       * redirect pin in prose — a mention is not a call, and a test that cannot tell them
       * apart teaches people to stop writing the prose.
       */
      const source = readFileSync(join(APP, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

      if (entry.reaches === "outbound") {
        expect(source, `${file} imports from lib/connectors but never calls runConnector`).toMatch(
          /runConnector\s*\(/,
        );
      } else {
        expect(
          /runConnector\s*\(/.test(source),
          `${file} is declared as reaching no upstream, but it calls runConnector`,
        ).toBe(false);
        expect(
          /Driver\b/.test(source),
          `${file} is declared as reaching no upstream, but it imports a driver`,
        ).toBe(false);
      }

      for (const identifier of BYPASS_IDENTIFIERS) {
        expect(
          new RegExp(`\\b${identifier}\\b`).test(source),
          `${file} reaches ${identifier} directly, which skips the entry counter`,
        ).toBe(false);
      }
      expect(
        /\.\s*fetch\s*\(/.test(source),
        `${file} calls a driver's fetch member directly, which skips every check in runConnector`,
      ).toBe(false);
    }
  });

  it("`middleware.ts` says why it does not cover these paths, rather than leaving it unstated", () => {
    const middleware = readFileSync(join(ROOT, "middleware.ts"), "utf8");
    expect(middleware).toMatch(/matcher:\s*\["\/workspaces\/:path\*",\s*"\/admin\/:path\*"\]/);
    // The matcher is the reason nothing above these routes counts anything. QV-25 fix 3.
    expect(middleware).toMatch(/toolbench/i);
    expect(middleware).toMatch(/connector-entry/);
  });
});

/* ------------------------------------------------------------------ *
 * The behavioural half: the door counts, and it counts first
 * ------------------------------------------------------------------ */

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

function liveRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    slug: "qv25-connector",
    name: "QV-25 fixture",
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
    perUserQuota: 50,
    globalCeiling: 50,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: 300,
    staleWhileRevalidateSeconds: 300,
    enabled: true,
    status: "published",
    ...overrides,
  } as Connector;
}

const driver: ConnectorDriver<{ q: string }, { answer: string }> = {
  kind: "infrastructure",
  slug: "qv25-connector",
  normalise: (raw) => raw as { q: string },
  cacheKey: (params) => params.q,
  fetch: async (_connector, params) => ({ data: { answer: params.q }, upstreamStatus: 200 }),
};

const ALLOW = { ok: true, count: 1, limit: 120, remaining: 119, resetAt: new Date() };
const REFUSE = { ok: false, count: 121, limit: 120, remaining: 0, resetAt: new Date("2026-09-01T08:00:00Z") };

beforeEach(() => {
  getConnectorBySlug.mockReset();
  consume.mockReset();
  audit.mockReset();
});

describe("QV-25: runConnector consumes an entry budget before it does anything else", () => {
  it("counts one entry unit per call, keyed on the caller", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockResolvedValue(ALLOW);

    await runConnector(driver, { q: "a" }, { subject: "203.0.113.77" });

    const entry = consume.mock.calls.filter(([action]) => action === "connector-entry");
    expect(entry.length).toBe(1);
    expect(entry[0]?.[1]).toBe("203.0.113.77");
    // First, before the registry read: the point of the counter is to bound work, and a
    // counter consumed after the SELECT and the INSERT has not bounded either.
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      getConnectorBySlug.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("a spent caller reads no registry row, writes no audit row and opens no socket", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    const fetchSpy = vi.fn(async () => ({ data: { answer: "x" }, upstreamStatus: 200 }));
    consume.mockImplementation(async (action: string) =>
      action === "connector-entry" ? REFUSE : ALLOW,
    );

    const envelope = await runConnector(
      { ...driver, fetch: fetchSpy },
      { q: "a" },
      { subject: "203.0.113.77" },
    );

    expect(envelope.state).toBe("unavailable");
    expect(envelope.reason).toBe("quota-exhausted");
    expect(getConnectorBySlug).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the refusal is the same sentence for a cached question and an unasked one", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockResolvedValue(ALLOW);
    await runConnector(driver, { q: "victim-term" }, { subject: "victim" });

    consume.mockImplementation(async (action: string) =>
      action === "connector-entry" ? REFUSE : ALLOW,
    );
    const probe = await runConnector(driver, { q: "victim-term" }, { subject: "attacker" });
    const control = await runConnector(driver, { q: "never-typed" }, { subject: "attacker" });

    // The entry limiter must not become a second oracle: an attacker who has spent it must
    // not be able to tell a populated cache entry from an empty one either.
    expect(JSON.stringify(probe)).toBe(JSON.stringify(control));
  });

  it("fails OPEN when the counter itself is broken, and still refuses nothing silently", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockImplementation(async (action: string) => {
      if (action === "connector-entry") throw new Error("database is down");
      return ALLOW;
    });

    const envelope = await runConnector(driver, { q: "a" }, { subject: "s" });
    // This limiter protects OUR box, not a third party's fair-use ceiling: everything behind
    // it needs the same database, so failing closed buys nothing. The connector quotas below
    // it still fail CLOSED, which is asserted in connector-cache.test.ts.
    expect(envelope.state).toBe("fresh");
  });
});

describe("QV-25: a refused connector is not re-audited on every anonymous request", () => {
  it("writes one disabled row per connector per window, not one per request", async () => {
    const { runConnector, clearConnectorCache, clearRefusalMemo } = await import(
      "@/lib/connectors/runtime"
    );
    clearConnectorCache();
    clearRefusalMemo();
    getConnectorBySlug.mockResolvedValue(liveRow({ enabled: false, status: "draft" }));
    consume.mockResolvedValue(ALLOW);

    const envelopes = [];
    for (let i = 0; i < 20; i += 1) {
      envelopes.push(await runConnector(driver, { q: `q${i}` }, { subject: `client-${i}` }));
    }

    // Twenty anonymous requests against a switched-off connector.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(getConnectorBySlug).toHaveBeenCalledTimes(1);
    // And the twentieth caller is told exactly what the first was told, so a remembered
    // refusal is not distinguishable from a fresh one.
    expect(JSON.stringify(envelopes[19])).toBe(JSON.stringify(envelopes[0]));
    expect(envelopes[19]?.reason).toBe("disabled");
  });

  it("only refusals are remembered, so switching a source OFF still bites on the next request", async () => {
    const { runConnector, clearConnectorCache, clearRefusalMemo } = await import(
      "@/lib/connectors/runtime"
    );
    clearConnectorCache();
    clearRefusalMemo();
    consume.mockResolvedValue(ALLOW);

    getConnectorBySlug.mockResolvedValue(liveRow());
    const first = await runConnector(driver, { q: "live" }, { subject: "s" });
    expect(first.state).toBe("fresh");

    // The operator flips the kill-switch. No memo of a LIVE row exists, so the registry is
    // read again and the very next request is refused.
    getConnectorBySlug.mockResolvedValue(liveRow({ enabled: false }));
    const second = await runConnector(driver, { q: "live-2" }, { subject: "s" });
    expect(second.reason).toBe("disabled");
  });
});
