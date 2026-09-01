import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "@/lib/connectors/types";

/**
 * QA v2 regression suite for the connector kill-switch.
 *
 * Owned by qa-adversary. ADR 0012 §1 seeds every connector `enabled: false, status: 'draft'`
 * so that an operator must read the recorded legal basis and turn it on deliberately.
 * `lib/sources/governed.ts` states the rule the whole design rests on:
 *
 *   "A kill-switch that does not kill is worse than no kill-switch, because the operator
 *    believes the traffic stopped and stops looking."
 *
 * `pollSource` (the map) enforces it. `runConnector` (the Toolbench, and `/api/live/flights`)
 * DOES NOT — finding QA-V2-04. It resolves its row with `getConnectorBySlug`, whose own
 * docstring says "regardless of state", and then never reads `enabled`, `status`, `terms_url`
 * or `legal_basis` before calling the upstream.
 *
 * The first test below asserts the DEFECT as it behaves today, so the fix cannot land without
 * the assertion being deliberately inverted. The second is the assertion the fix must satisfy
 * Written first as `it.fails`, which turned green the moment the guard existed. Now plain
 * assertions: the defect is fixed and these are the regression guards.
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
}));
vi.mock("@/lib/connectors/audit", () => ({
  recordConnectorRequest: (...args: unknown[]) => audit(...args),
  AUDIT_RETENTION_DAYS: 30,
}));

/** A registry row in the state every connector ships in: off, draft, never reviewed. */
function draftRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    slug: "qa-killswitch-connector",
    name: "QA connector",
    kind: "infrastructure",
    operatorName: "QA",
    homepageUrl: "https://example.invalid/",
    termsUrl: "https://example.invalid/terms",
    attribution: "QA",
    attributionRequired: true,
    legalBasis: "QA fixture",
    baseUrl: "https://example.invalid",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 10,
    globalCeiling: 20,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 60,
    enabled: false,
    status: "draft",
    ...overrides,
  } as Connector;
}

async function runAgainst(row: Connector | null): Promise<{
  state: string;
  reason: string | null;
  calls: number;
}> {
  const { runConnector, clearConnectorCache } = await import("@/lib/connectors/runtime");
  clearConnectorCache();
  getConnectorBySlug.mockResolvedValue(row);
  consume.mockResolvedValue({ ok: true, count: 1, limit: 10, remaining: 9, resetAt: new Date() });

  const fetchSpy = vi.fn(async () => ({ data: { leaked: true }, upstreamStatus: 200 }));
  const driver: ConnectorDriver<Record<string, never>, { leaked: boolean }> = {
    kind: "infrastructure",
    slug: "qa-killswitch-connector",
    // The kill-switch runs before either quota, so this fixture is unaffected by the
    // per-actor ordering QV-02 introduced. Declared explicitly because the contract requires
    // every driver to state which kind of question it asks.
    perActor: false,
    normalise: () => ({}) as Record<string, never>,
    cacheKey: () => `k${Math.random()}`,
    fetch: fetchSpy,
  };

  const envelope = await runConnector(driver, {}, { subject: "anonymous" });
  return { state: envelope.state, reason: envelope.reason, calls: fetchSpy.mock.calls.length };
}

beforeEach(() => {
  getConnectorBySlug.mockReset();
  consume.mockReset();
  audit.mockReset();
});

describe("QA-V2-04: runConnector and the kill-switch", () => {
  it("refuses when there is no registry row at all", async () => {
    const result = await runAgainst(null);
    expect(result.state).toBe("unavailable");
    expect(result.reason).toBe("disabled");
    expect(result.calls).toBe(0);
  });

  // FIXED (QV-01). These two asserted the defect as it behaved; they now assert that it does
  // not. Every connector in this product ships `enabled = false, status = 'draft'`, so if the
  // guard regresses, thirteen upstreams are called by anyone who loads a page.
  it("makes NO request for a row that is enabled = false, status = draft", async () => {
    const result = await runAgainst(draftRow());
    expect(result.calls).toBe(0);
    expect(result.state).toBe("unavailable");
  });

  it("makes NO request for a row with no recorded terms or legal basis", async () => {
    const result = await runAgainst(draftRow({ termsUrl: null, legalBasis: null }));
    expect(result.calls).toBe(0);
    expect(result.state).toBe("unavailable");
  });

  it(
    "a disabled row makes no request and reports `disabled`",
    async () => {
      const result = await runAgainst(draftRow());
      expect(result.calls).toBe(0);
      expect(result.state).toBe("unavailable");
      expect(result.reason).toBe("disabled");
    },
  );

  it(
    "an enabled but unpublished row makes no request",
    async () => {
      const result = await runAgainst(draftRow({ enabled: true, status: "draft" }));
      expect(result.calls).toBe(0);
    },
  );

  it(
    "a published, enabled row with no legal basis makes no request",
    async () => {
      const result = await runAgainst(
        draftRow({ enabled: true, status: "published", legalBasis: null }),
      );
      expect(result.calls).toBe(0);
    },
  );

  it("an enabled, published row with terms and a basis is called — the control case", async () => {
    const result = await runAgainst(draftRow({ enabled: true, status: "published" }));
    expect(result.state).toBe("fresh");
    expect(result.calls).toBe(1);
  });
});
