import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";
import type { SourceAdapter, SourceFeature, SourceQuery } from "@/lib/sources/types";

/**
 * The two shared caches on the outbound path.
 *
 * 1. The map payload cache (`app/(public)/map/sources.ts`) is keyed on slug plus normalised
 *    query, so one viewport's features are never served for another, while identical
 *    questions still share an entry.
 * 2. The connector payload cache (`lib/connectors/runtime.ts`) must not let a reader learn
 *    whether, or when, someone else looked something up.
 */

const consume = vi.fn();
const audit = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  consume: (...args: unknown[]) => consume(...args),
  hashSubject: (s: string) => s,
}));
vi.mock("@/lib/connectors/audit", () => ({
  recordConnectorRequest: (...args: unknown[]) => audit(...args),
  AUDIT_RETENTION_DAYS: 30,
}));
vi.mock("@/lib/queries/live", () => ({ getConnectorBySlug: async () => null }));

/* ------------------------------------------------------------------ *
 * The map's payload cache must not ignore the viewport
 * ------------------------------------------------------------------ */

const pollSource = vi.fn();
vi.mock("@/lib/sources", () => ({
  findAdapter: () => null,
  pollSource: (...args: unknown[]) => pollSource(...args),
  healthcheckSource: async () => ({ ok: true, detail: "" }),
  WORKER_ACTOR_SUBJECT: "worker",
}));

const attribution = { text: "Test source", licence: "test" } as const;

const viewportAdapter: SourceAdapter<SourceFeature> = {
  slug: "qa-viewport-source",
  name: "QA viewport source",
  kind: "aircraft",
  homepage: "https://example.invalid/",
  attribution,
  ttlSeconds: 600,
  staleWhileRevalidateSeconds: 600,
  responseSchema: z.never(),
  normalise: () => [],
  fetch: async () => ({ ok: true as const, features: [], observedAt: new Date() }),
  healthcheck: async () => ({ ok: true, detail: "" }),
};

/** Every poll answers for the bbox it was handed, so any mixing is visible in the output. */
function answerForTheBboxAsked(): void {
  pollSource.mockImplementation(async (_adapter: unknown, query: SourceQuery) => ({
    result: {
      ok: true as const,
      features: [
        {
          id: `feature-at-${query.bbox?.west ?? "world"}`,
          kind: "aircraft",
          longitude: query.bbox?.west ?? 0,
          latitude: 0,
          label: `answer for west=${query.bbox?.west ?? "world"}`,
          properties: {},
        },
      ],
      observedAt: new Date(),
    },
    ttlSeconds: 600,
    attribution,
    connectorSlug: viewportAdapter.slug,
  }));
}

/** The label of the single feature a successful load returned. */
function answerLabel(load: { result: { ok: boolean } }): string {
  const result = load.result as { ok: true; features: readonly SourceFeature[] } | { ok: false };
  if (!result.ok) throw new Error("expected a successful load");
  const label = result.features[0]?.label;
  if (label === undefined) throw new Error("expected one feature");
  return label;
}

describe("the map payload cache is keyed on the source slug AND the query", () => {
  beforeEach(() => {
    pollSource.mockReset();
    // The module-level cache lives on globalThis so the dev server can survive a re-evaluate.
    const g = globalThis as typeof globalThis & { __cairnMapSourceCache?: Map<string, unknown> };
    g.__cairnMapSourceCache?.clear();
    answerForTheBboxAsked();
  });

  const LONDON = { bbox: { west: -1, south: 51, east: 1, north: 52 } } as const;
  const TOKYO = { bbox: { west: 139, south: 35, east: 141, north: 36 } } as const;

  it("a second viewport is polled for itself, and never handed the first one's features", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    const london = await loadSource(viewportAdapter, LONDON);
    expect(london.result.ok).toBe(true);
    expect(pollSource).toHaveBeenCalledTimes(1);

    const tokyo = await loadSource(viewportAdapter, TOKYO);

    expect(pollSource).toHaveBeenCalledTimes(2);
    expect(answerLabel(tokyo)).toBe("answer for west=139");
    expect(tokyo.stale).toBe(false);

    // And London is still London.
    const londonAgain = await loadSource(viewportAdapter, LONDON);
    expect(answerLabel(londonAgain)).toBe("answer for west=-1");
    expect(pollSource).toHaveBeenCalledTimes(2);
  });

  it("still shares one entry between readers asking the same question", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    await loadSource(viewportAdapter, LONDON);
    await loadSource(viewportAdapter, LONDON);
    // One shared payload for everyone asking the same question.
    expect(pollSource).toHaveBeenCalledTimes(1);
  });

  it("shares an entry between viewports that differ by less than the grid", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    await loadSource(viewportAdapter, { bbox: { west: -0.94, south: 51.2, east: 0.4, north: 51.6 } });
    await loadSource(viewportAdapter, { bbox: { west: -0.61, south: 51.4, east: 0.1, north: 51.9 } });

    // Snapping to a grid keeps small pans from creating new entries.
    expect(pollSource).toHaveBeenCalledTimes(1);
    const [, firstQuery] = pollSource.mock.calls[0] as [unknown, SourceQuery];
    // Snapped outward, so the upstream box contains the requested one.
    expect(firstQuery.bbox).toEqual({ west: -1, south: 51, east: 1, north: 52 });
  });

  it("keeps one entry for every reader of a source with no bounding box", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    // Global layers pass `{}` and share one entry.
    await loadSource(viewportAdapter, {});
    await loadSource(viewportAdapter, {});
    expect(pollSource).toHaveBeenCalledTimes(1);

    // A bounded viewport is a different question from the whole feed.
    await loadSource(viewportAdapter, LONDON);
    expect(pollSource).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * The connector payload cache is not a cross-user oracle
 * ------------------------------------------------------------------ */

/**
 * The per-user quota is consumed before the cache is read, so a cache hit costs a unit and a
 * refusal is audited; `fetchedAt` is quantised to the cache window. This applies to every
 * driver unconditionally (see `lib/connectors/types.ts` and
 * `tests/security/flights-oracle.test.ts`).
 */

/** A row with every column `runConnector` reads, live: enabled, published, with a basis. */
function liveConnector(overrides: Record<string, unknown> = {}): Connector {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    slug: "qa-oracle-connector",
    attribution: "QA",
    enabled: true,
    status: "published",
    termsUrl: "https://example.invalid/terms",
    legalBasis: "QA fixture; this row exists only in this test process.",
    cacheTtlSeconds: 3600,
    staleWhileRevalidateSeconds: 3600,
    globalCeiling: 100,
    perUserQuota: 100,
    windowSeconds: 60,
    timeoutMs: 5000,
    baseUrl: "https://example.invalid",
    ...overrides,
    // Only these columns are read by `runConnector`.
  } as unknown as Connector;
}

const perActorDriver: ConnectorDriver<{ query: string }, { secret: string }> = {
  kind: "infrastructure",
  slug: "qa-oracle-connector",
  normalise: (raw: unknown) => raw as { query: string },
  cacheKey: (params) => params.query,
  fetch: async (_c, params) => ({
    data: { secret: `captures for ${params.query}` },
    upstreamStatus: 200,
  }),
};

const allowed = { ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() };
const spent = { ok: false, count: 999, limit: 100, remaining: 0, resetAt: new Date() };

describe("the connector payload cache is not a cross-user oracle", () => {
  beforeEach(() => {
    consume.mockReset();
    audit.mockReset();
  });

  it("refuses a spent actor identically whether or not somebody else looked this up", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const connector = liveConnector();

    consume.mockResolvedValue(allowed);
    const victim = await runConnector(
      perActorDriver,
      { query: "victim-domain.example" },
      { subject: "victim" },
      { connector },
    );
    expect(victim.state).toBe("fresh");

    // The attacker's connector quota is spent. `connector-entry` stays open since it refuses
    // before the registry is read, which would test something else.
    consume.mockImplementation(async (action: string) =>
      action === "connector-entry" ? allowed : spent,
    );
    audit.mockClear();

    const probe = await runConnector(
      perActorDriver,
      { query: "victim-domain.example" },
      { subject: "attacker" },
      { connector },
    );
    const control = await runConnector(
      perActorDriver,
      { query: "never-searched.example" },
      { subject: "attacker" },
      { connector },
    );

    // A cached and an uncached term are indistinguishable.
    expect(probe.state).toBe("unavailable");
    expect(probe.reason).toBe("quota-exhausted");
    expect(probe.data).toBeNull();
    expect(probe.fetchedAt).toBeNull();
    expect(control.state).toBe(probe.state);
    expect(control.reason).toBe(probe.reason);
    expect(control.data).toBe(probe.data);
    expect(control.fetchedAt).toBe(probe.fetchedAt);

    // Both were quota-checked and audited.
    expect(consume.mock.calls.some(([action]) => action === "connector-user")).toBe(true);
    expect(audit.mock.calls).toHaveLength(2);
    for (const [entry] of audit.mock.calls) {
      expect((entry as { outcome: string }).outcome).toBe("quotaDenied");
    }
  });

  it("charges a per-actor cache hit a quota unit while still making no upstream call", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const connector = liveConnector();
    const fetchSpy = vi.fn(async () => ({ data: { secret: "s" }, upstreamStatus: 200 }));
    const driver = { ...perActorDriver, fetch: fetchSpy };

    consume.mockResolvedValue(allowed);

    await runConnector(driver, { query: "shared.example" }, { subject: "a" }, { connector });
    const userCallsAfterFirst = consume.mock.calls.filter(
      ([action]) => action === "connector-user",
    ).length;

    const second = await runConnector(
      driver,
      { query: "shared.example" },
      { subject: "b" },
      { connector },
    );

    expect(second.state).toBe("fresh");
    // One upstream call for both readers.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // But the second reader still paid a quota unit.
    const userCallsAfterSecond = consume.mock.calls.filter(
      ([action]) => action === "connector-user",
    ).length;
    expect(userCallsAfterSecond).toBe(userCallsAfterFirst + 1);
    // A cache hit isn't an outbound call, so it isn't audited as one.
    expect(audit.mock.calls).toHaveLength(1);
  });

  it("does not hand a second reader the first reader's fetch instant", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const connector = liveConnector({ cacheTtlSeconds: 900 });
    consume.mockResolvedValue(allowed);

    const first = await runConnector(
      perActorDriver,
      { query: "when.example" },
      { subject: "a" },
      { connector },
    );
    const second = await runConnector(
      perActorDriver,
      { query: "when.example" },
      { subject: "b" },
      { connector },
    );

    const at = second.fetchedAt;
    if (at === null) throw new Error("expected a timestamp");
    // Quantised to the cache window.
    expect(at.getTime() % (900 * 1000)).toBe(0);
    // Both readers see the same value.
    expect(first.fetchedAt?.getTime()).toBe(at.getTime());
  });

  /** Live layers share the cache entry, but reads are still charged per reader. */
  it("a live layer keeps ONE shared upstream call, and still charges each reader for the read", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const connector = liveConnector({ slug: "qa-shared-connector", cacheTtlSeconds: 60 });

    const fetchSpy = vi.fn(async () => ({ data: { n: 1 }, upstreamStatus: 200 }));
    const viewportDriver: ConnectorDriver<{ bbox: string }, { n: number }> = {
      kind: "flights",
      slug: "qa-shared-connector",
      normalise: (raw: unknown) => raw as { bbox: string },
      cacheKey: (params) => params.bbox,
      fetch: fetchSpy,
    };

    consume.mockResolvedValue(allowed);
    const first = await runConnector(
      viewportDriver,
      { bbox: "0,0,1,1" },
      { subject: "a" },
      { connector },
    );
    const spendsAfterFirst = consume.mock.calls.filter(
      ([action]) => action === "connector-user",
    ).length;

    const second = await runConnector(
      viewportDriver,
      { bbox: "0,0,1,1" },
      { subject: "b" },
      { connector },
    );

    expect(first.state).toBe("fresh");
    expect(second.state).toBe("fresh");
    // One shared entry, one upstream call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The second reader paid for the read.
    expect(
      consume.mock.calls.filter(([action]) => action === "connector-user").length,
    ).toBe(spendsAfterFirst + 1);
    // fetchedAt is the cache window, not the first reader's instant.
    expect((second.fetchedAt?.getTime() ?? 1) % (60 * 1000)).toBe(0);
    expect(second.fetchedAt?.getTime()).toBe(first.fetchedAt?.getTime());
  });
});
