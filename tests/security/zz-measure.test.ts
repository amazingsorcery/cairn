import { describe, expect, it, vi, beforeEach } from "vitest";

import type { Connector } from "@/db/schema";

/** TEMPORARY measurement harness. Deleted before commit. */

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

function adsbRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-4000-8000-0000000000ad",
    slug: "adsb-lol",
    name: "adsb.lol",
    kind: "flights",
    operatorName: "adsb.lol",
    homepageUrl: "https://www.adsb.lol/",
    termsUrl: "https://api.adsb.lol/docs",
    attribution: "ODbL",
    attributionRequired: true,
    legalBasis: "ODbL 1.0",
    baseUrl: "https://api.adsb.lol",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 3,
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

const realFetch = globalThis.fetch;
let sockets = 0;

beforeEach(() => {
  getConnectorBySlug.mockReset();
  consume.mockReset();
  audit.mockReset();
  sockets = 0;
  globalThis.fetch = vi.fn(async () => {
    sockets += 1;
    return new Response(JSON.stringify({ ac: [], now: Date.now(), total: 141 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

describe("MEASURE", () => {
  it("QV-02 before: the flights oracle", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    const { flightsDriver } = await import("@/lib/connectors/flights");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(adsbRow());
    const used = new Map<string, number>();
    consume.mockImplementation(async (action: string, subject: string) => {
      const key = `${action}:${subject}`;
      const count = (used.get(key) ?? 0) + 1;
      used.set(key, count);
      const limit = action === "connector-user" ? 3 : 100;
      return { ok: count <= limit, count, limit, remaining: 0, resetAt: new Date() };
    });

    const victim = await runConnector(flightsDriver, { lat: 51.5, lon: -0.1, radius: 50 }, { subject: "198.51.100.7" });
    audit.mockClear();
    const before = consume.mock.calls.length;
    const probes = [];
    for (let i = 0; i < 4; i += 1) {
      probes.push(await runConnector(flightsDriver, { lat: 51.5, lon: -0.1, radius: 50 }, { subject: "203.0.113.99" }));
    }
    // eslint-disable-next-line no-console
    console.log("MEASURE-QV02", JSON.stringify({
      victimFetchedAt: victim.fetchedAt?.toISOString(),
      probeFetchedAt: probes.map((p) => p.fetchedAt?.toISOString()),
      probeStates: probes.map((p) => p.state),
      auditRowsForProbes: audit.mock.calls.length,
      quotaChecksForProbes: consume.mock.calls.length - before,
      sockets,
    }));
    expect(true).toBe(true);
  });

  it("QV-03 before: bytes pulled by the two drivers", async () => {
    const { overpassDriver } = await import("@/lib/connectors/overpass");
    const { flightsDriver } = await import("@/lib/connectors/flights");

    const measure = async (label: string, run: () => Promise<unknown>) => {
      const counter = { pulled: 0 };
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                counter.pulled += 1024 * 1024;
                if (counter.pulled > 512 * 1024 * 1024) {
                  controller.close();
                  return;
                }
                controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ) as unknown as typeof globalThis.fetch;
      await run().catch(() => undefined);
      // eslint-disable-next-line no-console
      console.log(`MEASURE-QV03 ${label} pulledMiB=${(counter.pulled / 1024 / 1024).toFixed(1)}`);
    };

    await measure("overpass", () =>
      overpassDriver.fetch(
        adsbRow({ slug: "overpass-api-de", baseUrl: "https://overpass-api.de" }),
        { query: "[out:json];out;" },
        new AbortController().signal,
      ),
    );
    await measure("flights", () =>
      flightsDriver.fetch(
        adsbRow(),
        { lat: 51, lon: 0, radius: 50 },
        new AbortController().signal,
      ),
    );
    globalThis.fetch = realFetch;
    expect(true).toBe(true);
  }, 120_000);

  it("QV-25 before: limiter consumption and audit rows for 100 anonymous requests", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    const { flightsDriver } = await import("@/lib/connectors/flights");
    clearConnectorCache();
    getConnectorBySlug.mockResolvedValue(adsbRow({ enabled: false, status: "draft" }));
    consume.mockResolvedValue({ ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() });
    for (let i = 0; i < 100; i += 1) {
      await runConnector(flightsDriver, { lat: 51.5, lon: -0.1, radius: 50 }, { subject: `client-${i}` });
    }
    // eslint-disable-next-line no-console
    console.log("MEASURE-QV25", JSON.stringify({
      requests: 100,
      registryReads: getConnectorBySlug.mock.calls.length,
      auditRows: audit.mock.calls.length,
      limiterConsumptions: consume.mock.calls.length,
    }));
    expect(true).toBe(true);
  });
});
