import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";

/**
 * QA finding QV-02, REOPENED for `/api/live/flights`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT QA MEASURED, AND WHY THE DRIVER'S REASONING WAS WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * Seven drivers were given `perActor: true` and became byte-identical for a cached term and
 * an unasked one. `flightsDriver` declared `perActor: false`, so on `/api/live/flights` the
 * cache was read before any quota. Measured live with `adsb-lol` enabled, two clients
 * separated only by `X-Forwarded-For`:
 *
 *   victim   198.51.100.7   GET ?lat=51.5&lon=-0.1&radius=50
 *       fetchedAt = 2026-09-01T07:40:36.489Z
 *   attacker 203.0.113.99   the same cell, four times
 *       fetchedAt = 2026-09-01T07:40:36.489Z  x4, zero audit rows, zero quota
 *
 * The victim's exact millisecond, four times, free and unlogged, from a GET whose parameters
 * are in the URL — so the probe is a script over an 11 km grid rather than a POST body.
 *
 * The comment defending `perActor: false` argued that "a viewport is a question about the
 * world rather than about the reader". That is true of `/map`. **`/map` does not use this
 * driver.** The map's aircraft layer is `lib/sources/adsb-lol.ts` polled through
 * `lib/sources/governed.ts` under the worker actor; `flightsDriver` serves exactly two
 * surfaces, `/live/flights` and its refresh route, and on both the reader types the
 * coordinates. The flag was a claim about every present and future call site of the driver,
 * made in the driver, where the call sites cannot be seen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE FLAG IS GONE RATHER THAN CORRECTED
 * ─────────────────────────────────────────────────────────────────────────────
 * Setting `perActor: true` on this one driver would fix the instance the finding enumerated
 * and leave the property — "a driver may declare that its readers' questions are not
 * private" — available to the next driver. Whether a cache key contains caller-supplied
 * input is a fact about the CALL SITE, not about the driver, and `runConnector` cannot see
 * the call site. So there is no longer anything to declare: every `runConnector` call charges
 * the caller before the cache is read and quantises the instant on the way out. The last test
 * in this file asserts that the choice cannot be reintroduced.
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

/** The `adsb-lol` row as seeded, but live — the state QA measured in. */
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

/** A per-subject budget, so "the attacker spends their own quota" is a real thing here. */
function budgetedConsume(limits: Readonly<Record<string, number>>): void {
  const used = new Map<string, number>();
  consume.mockImplementation(async (action: string, subject: string) => {
    const key = `${action}:${subject}`;
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    const limit = limits[action] ?? 1000;
    return { ok: count <= limit, count, limit, remaining: Math.max(0, limit - count), resetAt: new Date() };
  });
}

describe("QV-02 reopened: /api/live/flights is not a free oracle for another reader's viewport", () => {
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
    // ADR 0014 §4 still holds: the upstream saw ONE call for the two readers.
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
    // Quantised down to the connector's 60 s cache window, epoch-aligned. "Somebody here was
    // watching aircraft within 11 km of this point at 07:40:36.489" is the sentence QV-02
    // was filed for; a window start is not that sentence.
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

describe("QV-02 reopened: the choice that produced it no longer exists", () => {
  const connectorDir = join(process.cwd(), "lib", "connectors");

  it("`ConnectorDriver` has no per-driver privacy flag to declare wrongly", () => {
    const types = readFileSync(join(connectorDir, "types.ts"), "utf8");
    expect(types).not.toMatch(/^\s*perActor\s*[?:]/m);
  });

  it("no driver, and no other file in the tree, still sets one", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(connectorDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      // Comments stripped: `types.ts` explains at length why the flag is gone, and a test
      // that cannot tell an explanation from a declaration teaches people to delete the
      // explanation.
      const code = readFileSync(join(connectorDir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (/(^|[^\w])perActor\s*:/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("`runConnector` charges the caller before the cache is read, unconditionally", async () => {
    const runtime = readFileSync(join(connectorDir, "runtime.ts"), "utf8");
    const quotaAt = runtime.indexOf('spendQuota("connector-user"');
    const cacheAt = runtime.indexOf("readCache(key)");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(-1);
    expect(quotaAt, "the per-user quota must be spent above the cache read").toBeLessThan(cacheAt);
    // And exactly once: the second, post-cache spend existed only for the shared path.
    expect(runtime.match(/spendQuota\("connector-user"/g)?.length).toBe(1);
  });
});
