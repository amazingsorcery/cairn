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
 * Backoff on upstream rate limits (429/420). End-to-end polling behaviour is covered in
 * `connectors.test.ts` and `components/live/flights-surface.tsx`.
 */

beforeEach(() => {
  clearCooldowns();
});

describe("isRateLimitStatus", () => {
  it("recognises 429", () => {
    expect(isRateLimitStatus(429)).toBe(true);
  });

  it("recognises 420 Enhance Your Calm", () => {
    // Non-standard, but adsb.lol has returned it.
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
    // adsb.lol sends no Retry-After, so callers fall back to DEFAULT_COOLDOWN_SECONDS.
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
    // A later 429 with a shorter wait must not shorten the cooldown.
    openCooldown("adsb-lol", 120, now);
    openCooldown("adsb-lol", 10, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(120);

    openCooldown("adsb-lol", 300, now);
    expect(cooldownRemaining("adsb-lol", now)).toBe(300);
  });

  it("defaults to a cooldown longer than the connector's own window", () => {
    // Upstream limit is unpublished; backing off less than a window re-enters the burst.
    expect(DEFAULT_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(60);
  });
});

/* ================================================================== *
 * What the audit log records when the upstream refuses us
 * ================================================================== */

const recorded: { outcome: string; upstreamStatus: number | null; durationMs: number }[] = [];

/**
 * The limiter is stubbed to permit so only the cooldown is under test. The quota is spent
 * before the cooldown check, and an unstubbed `consume` would fail closed (no DB here).
 */
vi.mock("@/lib/rate-limit", () => ({
  consume: vi.fn(async () => ({ ok: true, count: 1, limit: 100, remaining: 99, resetAt: new Date() })),
  hashSubject: (subject: string) => subject,
  clientSubject: () => "anon",
}));

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
  perActor: false,
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
    // Upstream refusal (rateLimited) must stay distinct from our own quota (quotaDenied).
    expect(recorded[0]?.outcome).toBe("rateLimited");
    expect(recorded[0]?.outcome).not.toBe("quotaDenied");
    // No request was made.
    expect(recorded[0]?.upstreamStatus).toBeNull();
    expect(recorded[0]?.durationMs).toBe(0);

    // The envelope reason must match the audit outcome.
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
    // `driver.fetch` throws if reached.
    await expect(
      runConnector(driver, {}, { subject: "probe-subject" }, { connector }),
    ).resolves.toMatchObject({ reason: "rate-limited" });
  });
});
