import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";

/**
 * `/api/live/flights` must not let a reader learn another reader's viewport via the cache.
 * On `/live/flights` the reader types the coordinates, so a cached cell (and its exact
 * `fetchedAt`) would reveal what someone else looked at.
 *
 * There is no per-driver opt-out: whether a cache key holds caller input depends on the call
 * site, which the driver can't see. `runConnector` charges every caller before reading the
 * cache and quantises `fetchedAt`. The last describe block guards against reintroducing a
 * per-driver flag.
 */

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

/** The seeded `adsb-lol` row, but live. */
function adsbRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-4000-8000-0000000000ad",
    slug: "adsb-lol",
    name: "adsb.lol",
    kind: "flights",
    operatorName: "adsb.lol",
    homepageUrl: "https://www.adsb.lol/",
    termsUrl: "https://api.adsb.lol/docs",
    attribution: "Aircraft data from adsb.lol, licensed under ODbL 1.0.",
    attributionRequired: true,
    legalBasis: "ODbL 1.0, free without a key.",
    baseUrl: "https://api.adsb.lol",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 6,
    globalCeiling: 6,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 600,
    enabled: true,
    status: "published",
    ...overrides,
  } as Connector;
}

const VIEWPORT = { lat: 51.5, lon: -0.1, radius: 50 };

let sockets: string[];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  getConnectorBySlug.mockReset();
  consume.mockReset();
  audit.mockReset();
  sockets = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    sockets.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ ac: [], now: Date.now(), total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

async function harness() {
  const { runConnector, clearConnectorCache, clearRefusalMemo } = await import(
    "@/lib/connectors/runtime"
  );
  const { flightsDriver } = await import("@/lib/connectors/flights");
  clearConnectorCache();
  clearRefusalMemo();
  return { runConnector, flightsDriver };
}

/**
 * A fixed window boundary rather than `new Date()`. The real limiter's `resetAt` is constant
 * within a fixed window; a per-call `new Date()` made the byte-identity check flaky.
 */
const WINDOW_RESET_AT = new Date("2026-09-01T00:01:00.000Z");

/** A per-subject budget, so "the attacker spends their own quota" is a real thing here. */
function budgetedConsume(limits: Readonly<Record<string, number>>): void {
  const used = new Map<string, number>();
  consume.mockImplementation(async (action: string, subject: string) => {
    const key = `${action}:${subject}`;
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    const limit = limits[action] ?? 1000;
    return {
      ok: count <= limit,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: WINDOW_RESET_AT,
    };
  });
}

describe("/api/live/flights is not a free oracle for another reader's viewport", () => {
  it("a spent attacker cannot tell the victim's cell from a cell nobody has viewed", async () => {
    const { runConnector, flightsDriver } = await harness();
    getConnectorBySlug.mockResolvedValue(adsbRow({ perUserQuota: 2 }));
    budgetedConsume({ "connector-user": 2, "connector-global": 100, "connector-entry": 1000 });

    await runConnector(flightsDriver, VIEWPORT, { subject: "198.51.100.7" });

    await runConnector(flightsDriver, { lat: 10, lon: 10, radius: 50 }, { subject: "203.0.113.99" });
    await runConnector(flightsDriver, { lat: 20, lon: 20, radius: 50 }, { subject: "203.0.113.99" });

    const probe = await runConnector(flightsDriver, VIEWPORT, { subject: "203.0.113.99" });
    const control = await runConnector(
      flightsDriver,
      { lat: 35, lon: 139, radius: 50 },
      { subject: "203.0.113.99" },
    );

    expect(JSON.stringify(probe)).toBe(JSON.stringify(control));
    expect(probe.reason).toBe("quota-exhausted");
    expect(probe.data).toBeNull();
    expect(probe.fetchedAt).toBeNull();
  });

  it("a cache hit costs the caller a quota unit and is not free", async () => {
    const { runConnector, flightsDriver } = await harness();
    getConnectorBySlug.mockResolvedValue(adsbRow());
    budgetedConsume({});

    await runConnector(flightsDriver, VIEWPORT, { subject: "victim" });
    consume.mockClear();
    const hit = await runConnector(flightsDriver, VIEWPORT, { subject: "attacker" });

    expect(hit.state).toBe("fresh");
    // One upstream call for both readers.
    expect(sockets.length).toBe(1);
    expect(consume.mock.calls.filter(([action]) => action === "connector-user").length).toBe(1);
  });

  it("the timestamp handed back cannot carry another reader's millisecond", async () => {
    const { runConnector, flightsDriver } = await harness();
    getConnectorBySlug.mockResolvedValue(adsbRow());
    budgetedConsume({});

    const victim = await runConnector(flightsDriver, VIEWPORT, { subject: "victim" });
    const attacker = await runConnector(flightsDriver, VIEWPORT, { subject: "attacker" });

    const at = attacker.fetchedAt;
    if (at === null) throw new Error("expected a timestamp");
    // Quantised to the 60 s cache window, so it can't reveal when someone else looked.
    expect(at.getTime() % (60 * 1000)).toBe(0);
    expect(victim.fetchedAt?.getTime()).toBe(at.getTime());
  });

  it("the same coarse instant is reported on a MISS, so the value does not distinguish the two", async () => {
    const { runConnector, flightsDriver } = await harness();
    getConnectorBySlug.mockResolvedValue(adsbRow());
    budgetedConsume({});

    const miss = await runConnector(flightsDriver, { lat: 35, lon: 139, radius: 50 }, { subject: "a" });
    expect(miss.state).toBe("fresh");
    expect((miss.fetchedAt?.getTime() ?? 1) % (60 * 1000)).toBe(0);
  });
});

describe("there is no per-driver cache privacy flag", () => {
  const connectorDir = join(process.cwd(), "lib", "connectors");

  it("`ConnectorDriver` has no per-driver privacy flag to declare wrongly", () => {
    const types = readFileSync(join(connectorDir, "types.ts"), "utf8");
    expect(types).not.toMatch(/^\s*perActor\s*[?:]/m);
  });

  it("no driver, and no other file in the tree, still sets one", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(connectorDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      // Strip comments so explanations of the flag don't count.
      const code = readFileSync(join(connectorDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/(^|[^\w])perActor\s*:/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("`runConnector` charges the caller before the cache is read, unconditionally", async () => {
    const runtime = readFileSync(join(connectorDir, "runtime.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Match the call (possibly split across lines), not the parameter type.
    const spends = [...runtime.matchAll(/spendQuota\(\s*"connector-user"/g)];
    const quotaAt = spends[0]?.index ?? -1;
    const cacheAt = runtime.indexOf("readCache(key)");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(quotaAt, "the per-user quota must be spent above the cache read").toBeLessThan(cacheAt);
    // Exactly once; charging twice would halve the configured quota.
    expect(spends.length).toBe(1);
  });
});
