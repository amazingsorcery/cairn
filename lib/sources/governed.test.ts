import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Connector } from "@/db/schema";
import type { AuditEntry } from "@/lib/connectors/audit";
import { hashSubject } from "@/lib/rate-limit";

import { adsbLol } from "./adsb-lol";
import { resetSourceRuntime } from "./http";
import {
  healthcheckSource,
  pollSource,
  resetGovernanceMemo,
  WORKER_ACTOR_SUBJECT,
  type GovernanceDeps,
} from "./governed";

import fixture from "./__fixtures__/adsb-lol.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

/**
 * The governed path. These tests are the proof for the two claims that matter:
 *
 *   1. **A disabled connector makes no outbound call.** A kill-switch that does not kill is
 *      worse than none, because the operator believes the traffic stopped.
 *   2. **A poll writes exactly one audit row, with a hashed actor.** QA finding Q-02 was found
 *      by reading that table; six adapters calling out unaudited is the same blindness rebuilt.
 */

/** A minimal live row. Only the columns the governed path reads are meaningful. */
function connectorRow(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "adsb-lol",
    name: "adsb.lol",
    kind: "aircraft",
    operatorName: "adsb.lol",
    homepageUrl: "https://www.adsb.lol/",
    termsUrl: "https://api.adsb.lol/docs",
    attribution: "Aircraft data from adsb.lol, licensed under ODbL 1.0",
    attributionRequired: true,
    legalBasis: "ODbL 1.0, read 2026-08-31",
    baseUrl: "https://api.adsb.lol",
    requiresApiKey: false,
    apiKeyEnvVar: null,
    perUserQuota: 3,
    globalCeiling: 6,
    windowSeconds: 60,
    timeoutMs: 5000,
    cacheTtlSeconds: 60,
    staleWhileRevalidateSeconds: 600,
    pollMode: "worker",
    enabled: true,
    status: "published",
    lastCheckedAt: null,
    notes: null,
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Connector;
}

function harness(options: { connector?: Connector | null; ceilingOk?: boolean } = {}) {
  const rows: AuditEntry[] = [];
  const deps: Partial<GovernanceDeps> = {
    getConnector: () =>
      Promise.resolve(options.connector === undefined ? connectorRow() : options.connector),
    consumeGlobal: () => Promise.resolve({ ok: options.ceilingOk ?? true }),
    audit: (entry) => {
      rows.push(entry);
      return Promise.resolve();
    },
  };
  return { rows, deps };
}

beforeEach(() => {
  resetSourceRuntime();
  resetGovernanceMemo();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
  resetGovernanceMemo();
});

describe("the kill-switch actually kills", () => {
  it("makes NO outbound call when the connector is disabled", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { rows, deps } = harness({ connector: connectorRow({ enabled: false }) });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);

    // The whole point. Not "returned a cached value", not "returned an error after calling".
    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
    if (poll.result.ok) return;
    expect(poll.result.failure.kind).toBe("disabled");
    if (poll.result.failure.kind !== "disabled") return;
    expect(poll.result.failure.reason).toContain("switched this source off");

    // The refusal is still audited: a control denying traffic is the most useful thing this
    // table can show, and it is invisible if only successful calls are recorded (ADR 0013 §4).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("disabled");
    expect(rows[0]?.durationMs).toBe(0);
    expect(rows[0]?.upstreamStatus).toBeNull();
  });

  it("makes no call for a draft connector, however enabled it looks", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness({ connector: connectorRow({ status: "draft" }) });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
  });

  it("makes no call for a connector with no recorded legal basis", async () => {
    // ADR 0012's CHECK constraints exist to make this unstorable; re-checking here means the
    // governed path cannot be the place that slips.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness({ connector: connectorRow({ legalBasis: null }) });

    await pollSource(adsbLol, {}, testContext(), deps);
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes no call when the source has no registry row at all", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { rows, deps } = harness({ connector: null });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
    // No row means no connector id to reference, so there is nothing to audit against —
    // failing closed is the behaviour, and the log line is in the application log instead.
    expect(rows).toHaveLength(0);
  });

  it("fails closed when the registry itself is unreachable", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const poll = await pollSource(adsbLol, {}, testContext(), {
      getConnector: () => Promise.reject(new Error("database down")),
      audit: () => Promise.resolve(),
    });

    // We could not prove we are allowed to call, so we do not call.
    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
  });
});

describe("the audit row", () => {
  it("writes exactly one row for a successful poll, with a hashed actor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { rows, deps } = harness();

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.result.ok).toBe(true);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.outcome).toBe("ok");
    expect(row?.upstreamStatus).toBe(200);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.subject).toBe(WORKER_ACTOR_SUBJECT);
  });

  it("hashes the actor to something that cannot contain an identity", () => {
    /**
     * `recordConnectorRequest` hashes `subject` before it reaches the database, and
     * `connector_requests_actor_key_check` requires 64 hex characters — so an email, a dotted
     * quad or a uuid is structurally impossible to store. Asserted here on the construction
     * this module feeds it.
     */
    const actorKey = hashSubject(WORKER_ACTOR_SUBJECT);
    expect(actorKey).toMatch(/^[0-9a-f]{64}$/);
    expect(actorKey).not.toContain("@");
    // No dotted quad, i.e. nothing that could be an IP address.
    expect(actorKey).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("records a 429 as rateLimited carrying the real status, not as a generic error", async () => {
    // The distinction Q-02 turned on: being told to slow down is not the source being broken.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429 }));
    const { rows, deps } = harness();

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.result.ok).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("rateLimited");
    expect(rows[0]?.upstreamStatus).toBe(429);
  });

  it("records an upstream 500 with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const { rows, deps } = harness();

    await pollSource(adsbLol, {}, testContext(), deps);
    expect(rows[0]?.outcome).toBe("upstreamError");
    expect(rows[0]?.upstreamStatus).toBe(500);
  });

  it("records a shape change as an upstream error that answered 200", async () => {
    // Both facts are true and both are useful on the board: the call succeeded, the payload
    // did not. Recording it as `ok` would hide a dead layer behind a green row.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }));
    const { rows, deps } = harness();

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.result.ok).toBe(false);
    if (poll.result.ok) return;
    expect(poll.result.failure.kind).toBe("schemaChanged");
    expect(rows[0]?.outcome).toBe("upstreamError");
    expect(rows[0]?.upstreamStatus).toBe(200);
  });
});

describe("the global ceiling", () => {
  it("refuses the call when the ceiling is reached, and audits it as our refusal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { rows, deps } = harness({ ceilingOk: false });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);

    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
    // `quotaDenied`, not `rateLimited`: we refused ourselves against a ceiling we chose. An
    // operator reading this goes and tunes our quota, which is the right move here.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("quotaDenied");
    expect(rows[0]?.durationMs).toBe(0);
  });

  it("fails closed when the ceiling cannot be evaluated", async () => {
    // An uncounted call against somebody else's fair-use limit is a call we had no right to
    // make, so a broken limiter stops us rather than waving us through.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const rows: AuditEntry[] = [];

    const poll = await pollSource(adsbLol, {}, testContext(), {
      getConnector: () => Promise.resolve(connectorRow()),
      consumeGlobal: () => Promise.reject(new Error("rate limiter down")),
      audit: (e) => {
        rows.push(e);
        return Promise.resolve();
      },
    });

    expect(spy).not.toHaveBeenCalled();
    expect(poll.result.ok).toBe(false);
    expect(rows[0]?.outcome).toBe("quotaDenied");
  });

  it("passes the row's ceiling and window to the limiter, not a constant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const seen: { limit: number; windowSeconds: number }[] = [];

    await pollSource(adsbLol, {}, testContext(), {
      getConnector: () => Promise.resolve(connectorRow({ globalCeiling: 4, windowSeconds: 120 })),
      consumeGlobal: (_slug, policy) => {
        seen.push(policy);
        return Promise.resolve({ ok: true });
      },
      audit: () => Promise.resolve(),
    });

    expect(seen).toEqual([{ limit: 4, windowSeconds: 120 }]);
  });
});

describe("the row is authoritative for the TTL", () => {
  it("returns the row's cacheTtlSeconds, not the adapter's constant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness();

    const poll = await pollSource(adsbLol, {}, testContext(), deps);

    // ADR 0024 recorded these two disagreeing — 60s on the row, 30s in the adapter. The row
    // wins: it is what an operator can change under load without a deploy.
    expect(adsbLol.ttlSeconds).toBe(30);
    expect(poll.ttlSeconds).toBe(60);
  });

  it("falls back to the adapter's TTL only when there is no row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness({ connector: null });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.ttlSeconds).toBe(adsbLol.ttlSeconds);
  });

  it("returns the attribution, so a caller cannot render a layer without its credit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness();

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.attribution.licence).toBe("ODbL 1.0");
    expect(poll.connectorSlug).toBe("adsb-lol");
  });

  /**
   * QA finding QV-17: two files claimed the row was authoritative for the credit and every
   * branch returned the adapter's module constant, so editing `connectors.attribution` did
   * nothing. The strings agreed for every source, so nothing was mis-credited — but
   * attribution is exactly the field that has to be changeable without a deploy when a licence
   * changes its required wording.
   */
  it("renders the credit the registry row carries, not the adapter's constant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness({
      connector: connectorRow({ attribution: "Aircraft data from adsb.lol — revised wording" }),
    });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.attribution.text).toBe("Aircraft data from adsb.lol — revised wording");
    /* Only the text is the row's: there is no licence or href column to carry the rest. */
    expect(poll.attribution.licence).toBe(adsbLol.attribution.licence);
    expect(poll.attribution.href).toBe(adsbLol.attribution.href);
  });

  it("falls back to the adapter's credit when the row carries none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    /* A blank column is "nobody filled this in", not "no credit is owed". */
    const { deps } = harness({ connector: connectorRow({ attribution: "   " }) });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(poll.attribution.text).toBe(adsbLol.attribution.text);
  });

  it("carries the row's credit into a refusal, which is where a layer still has to render it", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { deps } = harness({
      connector: connectorRow({ enabled: false, attribution: "Credit owed even when switched off" }),
    });

    const poll = await pollSource(adsbLol, {}, testContext(), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(poll.attribution.text).toBe("Credit owed even when switched off");
  });
});

describe("healthcheckSource", () => {
  it("is governed too, so a dashboard cannot probe a disabled upstream", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness({ connector: connectorRow({ enabled: false }) });

    const health = await healthcheckSource(adsbLol, testContext(), deps);

    expect(spy).not.toHaveBeenCalled();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("switched this source off");
  });

  it("reports feature count and observation time when the source is live", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const { deps } = harness();

    const health = await healthcheckSource(adsbLol, testContext(), deps);
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("features");
  });
});

/**
 * QA finding QV-05. `/map` renders six layers per request and every one of them polled a
 * source that is switched off, so twenty anonymous page views wrote 120 `connector_requests`
 * rows and drove 120 `SELECT`s against `connectors` — on the one table `lib/rate-limit.ts`
 * calls "the only one in the schema with no natural bound", on a box where Postgres shares
 * the hardware with the app.
 *
 * The refusal is now remembered for a bounded window. THE ASYMMETRY IS THE WHOLE POINT and is
 * asserted below: only a REFUSAL is remembered, so switching a source OFF still takes effect
 * on the very next poll, and only switching one ON waits out the window.
 */
describe("a refusal is remembered, so a page view does not re-ask and re-record it", () => {
  function countingHarness(connector: Connector | null) {
    const rows: AuditEntry[] = [];
    let lookups = 0;
    const deps: Partial<GovernanceDeps> = {
      getConnector: () => {
        lookups += 1;
        return Promise.resolve(connector);
      },
      consumeGlobal: () => Promise.resolve({ ok: true }),
      audit: (entry) => {
        rows.push(entry);
        return Promise.resolve();
      },
    };
    return { rows, deps, lookups: () => lookups };
  }

  it("reads the registry once and writes one row for twenty polls of a disabled source", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const harnessed = countingHarness(connectorRow({ enabled: false }));

    for (let i = 0; i < 20; i += 1) {
      const poll = await pollSource(adsbLol, {}, testContext(), harnessed.deps);
      // Every caller still gets the same honest refusal, not a silent success.
      expect(poll.result.ok).toBe(false);
      if (poll.result.ok) return;
      expect(poll.result.failure.kind).toBe("disabled");
    }

    expect(spy).not.toHaveBeenCalled();
    // Twenty page views used to be twenty lookups and twenty rows.
    expect(harnessed.lookups()).toBe(1);
    expect(harnessed.rows).toHaveLength(1);
    expect(harnessed.rows[0]?.outcome).toBe("disabled");
  });

  it("remembers a missing registry row too, which is the shipped state for an unseeded source", async () => {
    const harnessed = countingHarness(null);

    await pollSource(adsbLol, {}, testContext(), harnessed.deps);
    await pollSource(adsbLol, {}, testContext(), harnessed.deps);

    expect(harnessed.lookups()).toBe(1);
    // No row means no `connector_id`, so there was never an audit row to suppress.
    expect(harnessed.rows).toHaveLength(0);
  });

  it("still stops on the very next poll when an operator switches a source OFF", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    let row = connectorRow({ enabled: true });
    const rows: AuditEntry[] = [];
    const deps: Partial<GovernanceDeps> = {
      getConnector: () => Promise.resolve(row),
      consumeGlobal: () => Promise.resolve({ ok: true }),
      audit: (entry) => {
        rows.push(entry);
        return Promise.resolve();
      },
    };

    const first = await pollSource(adsbLol, {}, testContext(), deps);
    expect(first.result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // 3am, an incident, the kill-switch goes over.
    row = connectorRow({ enabled: false });

    const second = await pollSource(adsbLol, {}, testContext(), deps);
    expect(second.result.ok).toBe(false);
    // No TTL between the flip and the traffic stopping. Nothing is cached on the way in.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("forgets the refusal when the window passes", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    let row: Connector | null = connectorRow({ enabled: false });
    let clock = new Date("2026-09-01T00:00:00.000Z");
    const deps: Partial<GovernanceDeps> = {
      getConnector: () => Promise.resolve(row),
      consumeGlobal: () => Promise.resolve({ ok: true }),
      audit: () => Promise.resolve(),
      now: () => clock,
    };

    await pollSource(adsbLol, {}, testContext(), deps);
    row = connectorRow({ enabled: true });

    // Inside the window the memo still answers, which is the trade: re-enabling waits.
    const during = await pollSource(adsbLol, {}, testContext(), deps);
    expect(during.result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + 61_000);
    const after = await pollSource(adsbLol, {}, testContext(), deps);
    expect(after.result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("carries the registry row's TTL and the adapter's credit through a remembered refusal", async () => {
    const harnessed = countingHarness(connectorRow({ enabled: false, cacheTtlSeconds: 45 }));

    const first = await pollSource(adsbLol, {}, testContext(), harnessed.deps);
    const second = await pollSource(adsbLol, {}, testContext(), harnessed.deps);

    // A remembered refusal must be indistinguishable from a freshly computed one, or a
    // caller would render a layer without its credit on the second request and with it on
    // the first.
    expect(second.ttlSeconds).toBe(first.ttlSeconds);
    expect(second.ttlSeconds).toBe(45);
    expect(second.attribution).toEqual(first.attribution);
    expect(second.connectorSlug).toBe(first.connectorSlug);
    if (first.result.ok || second.result.ok) throw new Error("expected two refusals");
    expect(second.result.failure).toEqual(first.result.failure);
  });
});
