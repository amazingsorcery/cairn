import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { ConnectorDriver } from "./types";

/**
 * QA finding QV-09 — the audit log undercounted outbound requests.
 *
 * `connector_requests` had one row per `runConnector` call. The DNS driver makes six requests
 * per lookup and RIPEstat four, so `cloudflare-doh`'s recorded ceiling of 20 lookups a minute
 * was really 120 requests a minute against Cloudflare and the table said 20 — wrong by a
 * constant factor, on the artefact that found v1's Q-02, in the direction that hides the
 * problem.
 *
 * The count is taken at the `fetch` itself rather than declared by the driver, so it cannot
 * drift when a driver adds a call and it picks up the ones a declaration would miss: a
 * redirect hop, a per-type failure that was still a request.
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

const PIN = "example.invalid";

function liveConnector(): Connector {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    slug: "qa-volume-connector",
    name: "QA volume connector",
    attribution: "QA",
    enabled: true,
    status: "published",
    termsUrl: "https://example.invalid/terms",
    legalBasis: "QA fixture.",
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 60,
    globalCeiling: 100,
    perUserQuota: 100,
    windowSeconds: 60,
    timeoutMs: 5000,
    baseUrl: `https://${PIN}`,
  } as unknown as Connector;
}

/** The count on the single audit row written by the last run. */
function auditedRequests(): number {
  const last = audit.mock.calls.at(-1)?.[0] as { upstreamRequests: number } | undefined;
  if (!last) throw new Error("no audit row was written");
  return last.upstreamRequests;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  consume.mockReset();
  audit.mockReset();
  consume.mockResolvedValue({ ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() });
  globalThis.fetch = realFetch;
});

/** A driver that fans out to `n` upstream GETs, the shape of the DNS and RIPEstat drivers. */
function fanOutDriver(n: number): ConnectorDriver<Record<string, never>, { n: number }> {
  return {
    kind: "infrastructure",
    slug: "qa-volume-connector",
    perActor: true,
    normalise: () => ({}) as Record<string, never>,
    cacheKey: () => `k${Math.random()}`,
    async fetch(connector, _params, signal) {
      const { upstreamGet } = await import("./toolbench");
      await Promise.all(
        Array.from({ length: n }, (_unused, index) =>
          upstreamGet({ url: `${connector.baseUrl}/${index}`, pinnedHost: PIN, signal }),
        ),
      );
      return { data: { n }, upstreamStatus: 200 };
    },
  };
}

describe("connector_requests records outbound volume, not attempts", () => {
  it("records six for a driver that queries six record types, as the DNS driver does", async () => {
    const { runConnector, clearConnectorCache } = await import("./runtime");
    clearConnectorCache();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    await runConnector(fanOutDriver(6), {}, { subject: "reader" }, { connector: liveConnector() });

    expect(auditedRequests()).toBe(6);
  });

  it("counts each redirect hop, because each hop is a request we made", async () => {
    const { runConnector, clearConnectorCache } = await import("./runtime");
    clearConnectorCache();

    let hop = 0;
    globalThis.fetch = vi.fn(async () => {
      hop += 1;
      return hop === 1
        ? new Response(null, { status: 302, headers: { location: `https://${PIN}/moved` } })
        : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const driver: ConnectorDriver<Record<string, never>, { ok: true }> = {
      kind: "infrastructure",
      slug: "qa-volume-connector",
      perActor: true,
      normalise: () => ({}) as Record<string, never>,
      cacheKey: () => "redirect",
      async fetch(connector, _params, signal) {
        const { upstreamGet } = await import("./toolbench");
        await upstreamGet({
          url: `${connector.baseUrl}/start`,
          pinnedHost: PIN,
          signal,
          maxRedirects: 2,
        });
        return { data: { ok: true as const }, upstreamStatus: 200 };
      },
    };

    await runConnector(driver, {}, { subject: "reader" }, { connector: liveConnector() });

    expect(auditedRequests()).toBe(2);
  });

  it("keeps the count on a failure: four requests then a refusal is still four requests", async () => {
    const { runConnector, clearConnectorCache } = await import("./runtime");
    clearConnectorCache();

    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call < 4 ? new Response("{}", { status: 200 }) : new Response("no", { status: 500 });
    }) as typeof fetch;

    const driver: ConnectorDriver<Record<string, never>, { ok: true }> = {
      kind: "infrastructure",
      slug: "qa-volume-connector",
      perActor: true,
      normalise: () => ({}) as Record<string, never>,
      cacheKey: () => "sequential",
      async fetch(connector, _params, signal) {
        const { upstreamGet } = await import("./toolbench");
        for (let index = 0; index < 6; index += 1) {
          await upstreamGet({ url: `${connector.baseUrl}/${index}`, pinnedHost: PIN, signal });
        }
        return { data: { ok: true as const }, upstreamStatus: 200 };
      },
    };

    const envelope = await runConnector(
      driver,
      {},
      { subject: "reader" },
      { connector: liveConnector() },
    );

    expect(envelope.state).toBe("unavailable");
    expect(auditedRequests()).toBe(4);
  });

  it("records zero for a refusal that made no request", async () => {
    const { runConnector, clearConnectorCache } = await import("./runtime");
    clearConnectorCache();
    consume.mockResolvedValue({ ok: false, count: 999, limit: 1, remaining: 0, resetAt: new Date() });
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    await runConnector(fanOutDriver(6), {}, { subject: "reader" }, { connector: liveConnector() });

    // Counting a refusal as one request would overstate our rate against the very limit this
    // table exists to let us verify, which is the same error in the other direction.
    expect(auditedRequests()).toBe(0);
  });
});
