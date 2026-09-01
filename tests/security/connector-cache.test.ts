import { beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";
import type { SourceAdapter, SourceFeature, SourceQuery } from "@/lib/sources/types";

/**
 * QA v2 regression tests for the two shared caches on the outbound path.
 *
 * Owned by qa-adversary. Both tests assert a DEFECT as it behaves today; when the fix lands,
 * the assertion has to be deliberately inverted, which is the point of writing it this way.
 *
 *   QA-V2-01  `app/(public)/map/sources.ts` keys the map's payload cache on the adapter slug
 *             alone, while `pollSource` is handed a viewport-scoped query. One reader's
 *             bounding box is then served to the next reader as `stale: false`.
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
 * QA-V2-01 — the map's payload cache ignores the viewport
 * ------------------------------------------------------------------ */

const pollSource = vi.fn();
vi.mock("@/lib/sources", () => ({
  findAdapter: () => null,
  pollSource: (...args: unknown[]) => pollSource(...args),
  healthcheckSource: async () => ({ ok: true, detail: "" }),
  WORKER_ACTOR_SUBJECT: "worker",
}));

describe("QA-V2-01: the map payload cache is keyed on the source slug, not the query", () => {
  beforeEach(() => {
    pollSource.mockReset();
    // The module-level cache lives on globalThis so the dev server can survive a re-evaluate.
    const g = globalThis as typeof globalThis & { __cairnMapSourceCache?: Map<string, unknown> };
    g.__cairnMapSourceCache?.clear();
  });

  it("DEFECT: a second viewport gets the first viewport's features, marked fresh", async () => {
    const { loadSource } = await import("@/app/(public)/map/sources");

    const attribution = { text: "Test source", licence: "test" } as const;
    const adapter: SourceAdapter<SourceFeature> = {
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

    // Every poll answers for the bbox it was handed, so any mixing is visible in the output.
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
      connectorSlug: adapter.slug,
    }));

    const london = await loadSource(adapter, { bbox: { west: -1, south: 51, east: 1, north: 52 } });
    expect(london.result.ok).toBe(true);
    expect(pollSource).toHaveBeenCalledTimes(1);

    const tokyo = await loadSource(adapter, { bbox: { west: 139, south: 35, east: 141, north: 36 } });

    // No second poll was made, and the Tokyo caller was handed the London answer.
    expect(pollSource).toHaveBeenCalledTimes(1);
    expect(tokyo.result.ok).toBe(true);
    if (!tokyo.result.ok) throw new Error("unreachable");
    expect(tokyo.result.features[0]?.label).toBe("answer for west=-1");
    // And it is presented as current data, not as stale or approximate.
    expect(tokyo.stale).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * QA-V2-02 — the connector payload cache is a cross-user oracle
 * ------------------------------------------------------------------ */

describe("QA-V2-02: a connector cache hit crosses actors, spends no quota and writes no audit row", () => {
  beforeEach(() => {
    consume.mockReset();
    audit.mockReset();
  });

  it("DEFECT: actor B reads actor A's result after B's own quota is exhausted", async () => {
    const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
    clearConnectorCache();

    const connector = {
      id: "00000000-0000-0000-0000-000000000001",
      slug: "qa-oracle-connector",
      attribution: "QA",
      cacheTtlSeconds: 3600,
      staleWhileRevalidateSeconds: 3600,
      globalCeiling: 100,
      perUserQuota: 100,
      windowSeconds: 60,
      timeoutMs: 5000,
      baseUrl: "https://example.invalid",
    };

    const fetchSpy = vi.fn(async () => ({
      data: { secret: "captures for victim-domain.example" },
      upstreamStatus: 200,
    }));
    const driver: ConnectorDriver<{ query: string }, { secret: string }> = {
      kind: "infrastructure",
      slug: connector.slug,
      normalise: (raw: unknown) => raw as { query: string },
      cacheKey: (params) => params.query,
      fetch: fetchSpy,
    };

    consume.mockResolvedValue({ ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() });

    // Actor A — the victim — makes the lookup. `connector` carries only the columns
    // runConnector reads, so it is widened rather than built as a full row.
    const first = await runConnector(driver, { query: "victim-domain.example" }, { subject: "victim" }, {
      connector: connector as unknown as Connector,
    });
    expect(first.state).toBe("fresh");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Actor B — the attacker — has spent everything. Every quota check now refuses.
    consume.mockResolvedValue({ ok: false, count: 999, limit: 100, remaining: 0, resetAt: new Date() });
    const consumeCallsBefore = consume.mock.calls.length;
    const auditRowsBefore = audit.mock.calls.length;

    const probe = await runConnector(driver, { query: "victim-domain.example" }, { subject: "attacker" }, {
      connector: connector as unknown as Connector,
    });

    // The refused actor still gets the victim's payload, and its exact fetch instant.
    expect(probe.state).toBe("fresh");
    expect(probe.data).toEqual({ secret: "captures for victim-domain.example" });
    expect(probe.fetchedAt?.getTime()).toBe(first.fetchedAt?.getTime());

    // No quota was spent and no audit row was written, so nothing records the probe.
    expect(consume.mock.calls.length).toBe(consumeCallsBefore);
    expect(audit.mock.calls.length).toBe(auditRowsBefore);

    // A term nobody looked up is refused — which is what makes the pair an oracle.
    const control = await runConnector(driver, { query: "never-searched.example" }, { subject: "attacker" }, {
      connector: connector as unknown as Connector,
    });
    expect(control.state).toBe("unavailable");
    expect(control.reason).toBe("quota-exhausted");
  });
});
