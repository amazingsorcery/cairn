import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COOLDOWN_SECONDS,
  cooldownRemaining,
  isRateLimitStatus,
  openCooldown,
  parseRetryAfter,
} from "./runtime";
import { clearCooldowns, runConnector } from "./runtime";

/**
 * Regression tests for QA finding Q-02.
 *
 * The audit log recorded 57 `429`s and one `420` against adsb.lol — 29% of every outbound
 * call refused — because nothing backed off and the client kept polling. product-brief §3.2
 * constraint 5 is "respect robots.txt, terms of service and rate limits", which this product
 * tells its own users is the line between OSINT and a computer-misuse offence.
 *
 * These tests are the guard on the mechanism. The end-to-end proof that the surface stops
 * polling is in `lib/connectors/connectors.test.ts` and the `live` computation in
 * `components/live/flights-surface.tsx`.
 */

beforeEach(() => {
  clearCooldowns();
});

describe("isRateLimitStatus", () => {
  it("recognises 429", () => {
    expect(isRateLimitStatus(429)).toBe(true);
  });

  it("recognises 420 Enhance Your Calm", () => {
    // Non-standard, and exactly what adsb.lol returned once in the audit log. Treating it as
    // a generic upstream error would keep us calling a service that asked us twice to stop.
    expect(isRateLimitStatus(420)).toBe(true);
  });

  it("does not treat ordinary failures as rate limits", () => {
    for (const status of [400, 401, 403, 404, 418, 421, 500, 502, 503, 504]) {
      expect(isRateLimitStatus(status)).toBe(false);
    }
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-08-31T10:00:00.000Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("  120 ", now)).toBe(120);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  it("reads an HTTP-date and converts it to seconds from now", () => {
    expect(parseRetryAfter("Mon, 31 Aug 2026 10:00:45 GMT", now)).toBe(45);
  });

  it("never returns a negative wait for a date already past", () => {
    expect(parseRetryAfter("Mon, 31 Aug 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns null when the header is absent or unparseable", () => {
    // adsb.lol sends none — measured 2026-08-31 — so this is the live path, and it must fall
    // through to DEFAULT_COOLDOWN_SECONDS rather than to zero.
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("the per-connector cooldown", () => {
  const now = new Date("2026-08-31T10:00:00.000Z");

  it("reports no cooldown for a connector that has not been refused", () => {
    expect(cooldownRemaining("adsb-lol", now)).toBe(0);
  });

  it("opens for the requested number of seconds", () => {
    openCooldown("adsb-lol", 30, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(30);
  });

  it("counts down and expires", () => {
    openCooldown("adsb-lol", 30, now);
    expect(cooldownRemaining("adsb-lol", new Date(now.getTime() + 29_000))).toBe(1);
    expect(cooldownRemaining("adsb-lol", new Date(now.getTime() + 30_000))).toBe(0);
    expect(cooldownRemaining("adsb-lol", new Date(now.getTime() + 60_000))).toBe(0);
  });

  it("is per connector, not global", () => {
    openCooldown("adsb-lol", 60, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(60);
    expect(cooldownRemaining("transport-for-london", now)).toBe(0);
  });

  it("extends but never shortens an existing cooldown", () => {
    // A second 429 arriving mid-cooldown must not reset the clock DOWN — that would let a
    // burst of refusals shorten the very backoff they should be lengthening.
    openCooldown("adsb-lol", 120, now);
    openCooldown("adsb-lol", 10, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(120);

    openCooldown("adsb-lol", 300, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(300);
  });

  it("defaults to a cooldown longer than the connector's own window", () => {
    // The upstream limiter is a load-dependent token bucket with no published number, so
    // backing off for less than one window would just re-enter the burst that caused it.
    expect(DEFAULT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(60);
  });
});

/* ================================================================== *
 * What the audit log records when the upstream refuses us
 * ================================================================== */

const recorded: { outcome: string; upstreamStatus: number | null; durationMs: number }[] = [];

vi.mock("./audit", () => ({
  AUDIT_RETENTION_DAYS: 30,
  recordConnectorRequest: vi.fn(async (entry: Record<string, unknown>) => {
    recorded.push({
      outcome: entry.outcome as string,
      upstreamStatus: (entry.upstreamStatus as number | null) ?? null,
      durationMs: entry.durationMs as number,
    });
  }),
}));

/** A registry row shaped like the seeded flights connector, with the cooldown path reachable. */
const connector = {
  id: "00000000-0000-4000-8000-000000000000",
  slug: "backoff-probe",
  name: "Backoff probe",
  kind: "flights",
  operatorName: "Probe",
  homepageUrl: "https://example.invalid",
  termsUrl: "https://example.invalid/terms",
  attribution: "Probe attribution",
  attributionRequired: true,
  legalBasis: "Probe.",
  baseUrl: "https://example.invalid",
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
  lastCheckedAt: new Date("2026-08-31T00:00:00Z"),
  notes: null,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Parameters<typeof runConnector>[3] extends { connector?: infer C } ? C : never;

const driver = {
  kind: "flights" as const,
  slug: "backoff-probe",
  normalise: (raw: unknown) => raw as Record<string, never>,
  cacheKey: () => "probe",
  fetch: async () => {
    throw new Error("the driver must not be called while a cooldown is open");
  },
};

describe("a cooldown refusal is audited as rateLimited, never as quotaDenied", () => {
  beforeEach(() => {
    clearCooldowns();
    recorded.length = 0;
  });

  it("records rateLimited with no upstream status and zero duration", async () => {
    openCooldown("backoff-probe", 45);

    const envelope = await runConnector(driver, {}, { subject: "probe-subject" }, { connector });

    expect(recorded).toHaveLength(1);
    // THE ASSERTION THIS TEST EXISTS FOR. `quotaDenied` would send an operator to tune OUR
    // ceiling; the fix for this event is to back off from THEIRS (migration 0005). Someone
    // collapsing the two outcomes back together must fail here.
    expect(recorded[0]?.outcome).toBe("rateLimited");
    expect(recorded[0]?.outcome).not.toBe("quotaDenied");
    // Nothing left the building, so there is no status and no wall-clock cost.
    expect(recorded[0]?.upstreamStatus).toBeNull();
    expect(recorded[0]?.durationMs).toBe(0);

    // The operator's view and the reader's view must describe the SAME event. An audit row
    // saying "they refused us" beside an envelope blaming our own quota would be two
    // accounts of one moment, and the health board is read against what users report.
    expect(envelope.reason).toBe("rate-limited");
    expect(envelope.reason).not.toBe("quota-exhausted");
  });

  it("returns the rate-limited reason so the client stops polling", async () => {
    openCooldown("backoff-probe", 45);

    const envelope = await runConnector(driver, {}, { subject: "probe-subject" }, { connector });

    expect(envelope.reason).toBe("rate-limited");
    expect(envelope.state).toBe("unavailable");
    expect(envelope.lastError).toMatch(/slow down/i);
  });

  it("does not call the upstream at all while the cooldown is open", async () => {
    openCooldown("backoff-probe", 45);
    // `driver.fetch` throws if reached; reaching it would be the bug this whole finding is
    // about — continuing to call a service that asked us to stop.
    await expect(
      runConnector(driver, {}, { subject: "probe-subject" }, { connector }),
    ).resolves.toMatchObject({ reason: "rate-limited" });
  });
});
