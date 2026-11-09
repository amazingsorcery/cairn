import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";

/**
 * Every request that can reach an upstream crosses one counter, `connector-entry`, inside
 * `runConnector`. It lives there rather than at each entry point so new surfaces can't forget
 * it.
 *
 * 1. Inventory: the files under `app/` that import `lib/connectors/` are exactly the list
 *    below, and each goes through `runConnector` rather than a driver or the primitive.
 * 2. Behaviour: `runConnector` consumes `connector-entry` before reading the registry, cache,
 *    audit log or network, and refuses identically for any question once spent.
 */

const ROOT = process.cwd();
const APP = join(ROOT, "app");

/**
 * Every file under `app/` that may reach `lib/connectors/`. New entry points must be added
 * here, so they get reviewed.
 */
type Entry = {
  /** What the surface is and who may reach it. */
  readonly note: string;
  /**
   * `outbound`: can trigger an upstream request, so must go through `runConnector`.
   * `constants`: only imports values/types; must not import a driver or `runConnector`.
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
 * Identifiers that bypass `runConnector`. Matched by identifier, not module, since harmless
 * helpers share those modules.
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

describe("the inventory of surfaces that can reach a connector", () => {
  it("is exactly the declared list — a new one fails this test rather than shipping quietly", () => {
    expect(entryPoints()).toEqual(Object.keys(INVENTORY).sort());
  });

  it("every one of them goes through runConnector, and none reaches the socket another way", () => {
    for (const [file, entry] of Object.entries(INVENTORY)) {
      // Strip comments so prose mentions don't count as calls.
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
    // The comment must explain why these paths are limited elsewhere.
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
    name: "Entry-counter fixture",
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

describe("runConnector consumes an entry budget before it does anything else", () => {
  it("counts one entry unit per call, keyed on the caller", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(liveRow());
    consume.mockResolvedValue(ALLOW);

    await runConnector(driver, { q: "a" }, { subject: "203.0.113.77" });

    const entry = consume.mock.calls.filter(([action]) => action === "connector-entry");
    expect(entry.length).toBe(1);
    expect(entry[0]?.[1]).toBe("203.0.113.77");
    // Before the registry read, so it bounds the DB work too.
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

    // The entry limiter must not reveal whether a cache entry exists.
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
    // This limiter protects our own server, and everything behind it needs the same DB, so
    // fail open. Connector quotas still fail closed (connector-cache.test.ts).
    expect(envelope.state).toBe("fresh");
  });
});

describe("a refused connector is not re-audited on every anonymous request", () => {
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
    // A remembered refusal looks identical to a fresh one.
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

    // Live rows aren't memoised, so the kill-switch applies on the next request.
    getConnectorBySlug.mockResolvedValue(liveRow({ enabled: false }));
    const second = await runConnector(driver, { q: "live-2" }, { subject: "s" });
    expect(second.reason).toBe("disabled");
  });
});
