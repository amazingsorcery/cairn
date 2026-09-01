import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";
import type { SourceAdapter, SourceFeature, SourceQuery } from "@/lib/sources/types";

/**
 * QA v2 regression tests for the two shared caches on the outbound path.
 *
 * Written by qa-adversary to assert each DEFECT as it behaved, so that fixing it would force
 * the assertion to be deliberately inverted rather than quietly deleted.
 *
 *   QA-V2-01  **Inverted 2026-09-01: this is now the guard.** `app/(public)/map/sources.ts`
 *             keyed the map's payload cache on the adapter slug alone while `pollSource` was
 *             handed a viewport-scoped query, so one reader's bounding box was served to the
 *             next reader as `stale: false` — a table of Tokyo's aircraft captioned as the
 *             answer for Europe. The key is now the slug plus the normalised query, and the
 *             assertions below are the shape that must not come back: a different viewport
 *             gets its own poll and its own answer, an equivalent viewport still shares one
 *             entry, and a query with no bounding box is shared by every reader (ADR 0014 §4).
 *
 *   QA-V2-02  `lib/connectors/runtime.ts` reads its payload cache BEFORE the per-user quota
 *             and BEFORE the audit row, and the key contains the reader's own query. An
 *             actor who has spent their quota can still read another actor's result, which
 *             turns the cache into a cross-user "who looked this up, and when" oracle.
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
 * QA-V2-01 — the map's payload cache must not ignore the viewport
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

describe("QA-V2-01: the map payload cache is keyed on the source slug AND the query", () => {
  beforeEach(() => {
    pollSource.mockReset();
    // The module-level cache lives on globalThis so the dev server can survive a re-evaluate.
    const g = globalThis as typeof globalThis & { __cairnMapSourceCache?: Map<string, unknown> };
    g.__cairnMapSourceCache?.clear();
    answerForTheBboxAsked();
  });

  const LONDON = { bbox: { west: -1, south: 51, east: 1, north: 52 } } as const;
  const TOKYO = { bbox: { west: 139, south: 35, east: 141, north: 36 } } as const;

  it("GUARD: a second viewport is polled for itself, and never handed the first one's features", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    const london = await loadSource(viewportAdapter, LONDON);
    expect(london.result.ok).toBe(true);
    expect(pollSource).toHaveBeenCalledTimes(1);

    const tokyo = await loadSource(viewportAdapter, TOKYO);

    /*
     * The defect: one poll, and Tokyo receiving `answer for west=-1` marked `stale: false`.
     * A reader would have seen London's aircraft captioned as the answer for Tokyo, with a
     * real observation instant under it and a `fresh` status row.
     */
    expect(pollSource).toHaveBeenCalledTimes(2);
    expect(answerLabel(tokyo)).toBe("answer for west=139");
    expect(tokyo.stale).toBe(false);

    /* And the reverse direction, which is how QA found it: London must still be London. */
    const londonAgain = await loadSource(viewportAdapter, LONDON);
    expect(answerLabel(londonAgain)).toBe("answer for west=-1");
    expect(pollSource).toHaveBeenCalledTimes(2);
  });

  it("still shares one entry between readers asking the same question", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    await loadSource(viewportAdapter, LONDON);
    await loadSource(viewportAdapter, LONDON);
    /*
     * The fix must not become "one upstream call per reader". ADR 0014 §4: one shared payload
     * serves everyone looking at the same place, which is what holds us inside the upstream's
     * ceiling and keeps the key from encoding who asked.
     */
    expect(pollSource).toHaveBeenCalledTimes(1);
  });

  it("shares an entry between viewports that differ by less than the grid", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    await loadSource(viewportAdapter, { bbox: { west: -0.94, south: 51.2, east: 0.4, north: 51.6 } });
    await loadSource(viewportAdapter, { bbox: { west: -0.61, south: 51.4, east: 0.1, north: 51.9 } });

    /*
     * Two readers a few hundred metres apart are asking the same question. If float noise from
     * a map's `getBounds()` produced a distinct entry per pixel of pan, the cache would be
     * useless and the ceiling unenforceable — which is the failure mode on the other side of
     * this fix from QV-04.
     */
    expect(pollSource).toHaveBeenCalledTimes(1);
    const [, firstQuery] = pollSource.mock.calls[0] as [unknown, SourceQuery];
    /* Snapped outward, so the box handed upstream contains the box the reader asked about. */
    expect(firstQuery.bbox).toEqual({ west: -1, south: 51, east: 1, north: 52 });
  });

  it("keeps one entry for every reader of a source with no bounding box", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    /*
     * The five global layers (earthquakes, weather, wildfires, cameras, radio) pass `{}`. They
     * must not regress into per-reader entries: sharing is correct for them, and it is what
     * ADR 0014 §4 is actually about.
     */
    await loadSource(viewportAdapter, {});
    await loadSource(viewportAdapter, {});
    expect(pollSource).toHaveBeenCalledTimes(1);

    /* And a bounded viewport is still a different question from the whole feed. */
    await loadSource(viewportAdapter, LONDON);
    expect(pollSource).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * QA-V2-02 — the connector payload cache was a cross-user oracle
 * ------------------------------------------------------------------ */

/**
 * Written by QA against the defect and inverted when the fix landed. The defect was:
 * `runConnector` read its payload cache BEFORE the per-user quota and BEFORE the audit row,
 * and the key contains the reader's own query — so an actor who had spent their quota could
 * still read another actor's result, free and untraceable, which is a "who looked this up,
 * and when" oracle.
 *
 * The fix is `ConnectorDriver.perActor`. A driver whose cache key contains caller input
 * consumes the per-user quota before the cache is consulted at all, so a hit costs a unit and
 * a refusal is audited, and its `fetchedAt` is quantised to the cache window so it cannot
 * carry another reader's instant.
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
    // Only the columns above are read by `runConnector`, so the row is widened rather than
    // built in full. A missing column here would be a defect in the runtime, not in the test.
  } as unknown as Connector;
}

const perActorDriver: ConnectorDriver<{ query: string }, { secret: string }> = {
  kind: "infrastructure",
  slug: "qa-oracle-connector",
  perActor: true,
  normalise: (raw: unknown) => raw as { query: string },
  cacheKey: (params) => params.query,
  fetch: async (_c, params) => ({
    data: { secret: `captures for ${params.query}` },
    upstreamStatus: 200,
  }),
};

const allowed = { ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() };
const spent = { ok: false, count: 999, limit: 100, remaining: 0, resetAt: new Date() };

describe("QA-V2-02: the connector payload cache is not a cross-user oracle", () => {
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

    // The attacker has spent everything. Every quota check now refuses.
    consume.mockResolvedValue(spent);
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

    // THE PROPERTY: the two answers are indistinguishable. A cached term and an uncached one
    // produce the same state, the same reason and the same absence of data and timestamp.
    expect(probe.state).toBe("unavailable");
    expect(probe.reason).toBe("quota-exhausted");
    expect(probe.data).toBeNull();
    expect(probe.fetchedAt).toBeNull();
    expect(control.state).toBe(probe.state);
    expect(control.reason).toBe(probe.reason);
    expect(control.data).toBe(probe.data);
    expect(control.fetchedAt).toBe(probe.fetchedAt);

    // And neither is silent: both spent a quota check and both wrote a refusal row.
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
    // ADR 0014 section 4 still holds: the upstream sees ONE call for the two readers.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // But the second reader paid for the answer, which is what removes the free oracle.
    const userCallsAfterSecond = consume.mock.calls.filter(
      ([action]) => action === "connector-user",
    ).length;
    expect(userCallsAfterSecond).toBe(userCallsAfterFirst + 1);
    // A cache hit is not an outbound call, so it is not audited as one (QV-05's ruling).
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
    // Quantised to the 15-minute cache window, so it cannot identify when anybody asked.
    expect(at.getTime() % (900 * 1000)).toBe(0);
    // Both readers see the same window, so the value carries nothing about who fetched.
    expect(first.fetchedAt?.getTime()).toBe(at.getTime());
  });

  it("leaves a shared live layer on the ADR 0014 section 4 path: no quota for a cache hit", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();
    const connector = liveConnector({ slug: "qa-shared-connector" });

    const sharedDriver: ConnectorDriver<{ bbox: string }, { n: number }> = {
      kind: "flights",
      slug: "qa-shared-connector",
      // A viewport is a question about the world, not a private query: every reader looking
      // at the same place asks the same thing, and one shared entry is the point.
      perActor: false,
      normalise: (raw: unknown) => raw as { bbox: string },
      cacheKey: (params) => params.bbox,
      fetch: async () => ({ data: { n: 1 }, upstreamStatus: 200 }),
    };

    consume.mockResolvedValue(allowed);
    const startedAt = Date.now();
    const first = await runConnector(
      sharedDriver,
      { bbox: "0,0,1,1" },
      { subject: "a" },
      { connector },
    );
    expect(first.state).toBe("fresh");
    // The exact upstream instant survives for a shared layer: it is the one number on a live
    // page that must not be rounded, and it says nothing about any reader. Quantising it to
    // this row's hour-long window would have put it before the call was even made.
    expect(first.fetchedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(startedAt);

    const before = consume.mock.calls.length;
    const second = await runConnector(
      sharedDriver,
      { bbox: "0,0,1,1" },
      { subject: "b" },
      { connector },
    );
    expect(second.state).toBe("fresh");
    expect(consume.mock.calls.length).toBe(before);
  });
});
