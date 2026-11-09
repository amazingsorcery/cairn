import { describe, expect, it } from "vitest";

import {
  RATE_LIMIT_ACTIONS,
  RATE_LIMIT_POLICIES,
  clientSubject,
  clientSubjectFromHeaders,
  deriveKey,
  hashSubject,
  windowEnd,
  windowStart,
} from "./rate-limit";

/**
 * Key derivation (a privacy control) and window arithmetic. Upsert concurrency needs a real
 * Postgres and isn't covered here.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

describe("hashSubject", () => {
  it("produces 64 lowercase hex characters", () => {
    expect(hashSubject("reporter@example.test")).toMatch(HEX_64);
    expect(hashSubject("203.0.113.7")).toMatch(HEX_64);
    expect(hashSubject("2001:db8::1")).toMatch(HEX_64);
    // The shape `connector_requests_actor_key_check` enforces.
    expect(hashSubject("0f8f7c2e-2f7a-4d1a-9c1e-6d1b0a0c2f3d")).toMatch(HEX_64);
  });

  it("is deterministic for the same subject", () => {
    expect(hashSubject("reporter@example.test")).toBe(hashSubject("reporter@example.test"));
  });

  it("normalises case and surrounding whitespace so one address is one subject", () => {
    expect(hashSubject("  Reporter@Example.test ")).toBe(hashSubject("reporter@example.test"));
  });

  it("separates different subjects", () => {
    expect(hashSubject("a@example.test")).not.toBe(hashSubject("b@example.test"));
  });
});

describe("deriveKey", () => {
  const subjects = [
    "reporter@example.test",
    "Very.Long+Tagged.Address@sub.domain.example.test",
    "203.0.113.7",
    "192.168.0.1",
    "2001:db8:85a3::8a2e:370:7334",
    "0f8f7c2e-2f7a-4d1a-9c1e-6d1b0a0c2f3d",
  ];

  /** `rate_limits.key` must never contain a plaintext email, IP or uuid. */
  it("never leaks an email address, an IP address or a uuid into the key", () => {
    for (const action of RATE_LIMIT_ACTIONS) {
      for (const subject of subjects) {
        const key = deriveKey(action, subject);
        const [prefix, hash, ...rest] = key.split(":");

        expect(prefix).toBe(action);
        expect(rest).toHaveLength(0);
        expect(hash).toMatch(HEX_64);

        expect(key).not.toContain("@");
        // Dotted quad, i.e. any IPv4 address.
        expect(key).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
        // Any bare dot at all: no domain fragment survives hashing either.
        expect(key.slice(action.length + 1)).not.toContain(".");
        // uuid hyphens.
        expect(hash).not.toContain("-");
        // And the subject itself must not appear anywhere, in any case form.
        expect(key.toLowerCase()).not.toContain(subject.trim().toLowerCase());
      }
    }
  });

  it("separates the same subject across actions", () => {
    expect(deriveKey("signin-email", "a@example.test")).not.toBe(
      deriveKey("search-suggest", "a@example.test"),
    );
  });
});

describe("windowStart", () => {
  it("aligns to the epoch, not to first use", () => {
    // 15-minute windows: 10:07:31 belongs to the window that began at 10:00:00.
    const at = new Date("2026-03-12T10:07:31.482Z");
    expect(windowStart(at, 900).toISOString()).toBe("2026-03-12T10:00:00.000Z");
  });

  it("puts two requests inside the same window into the same bucket", () => {
    const a = windowStart(new Date("2026-03-12T10:00:00.000Z"), 900);
    const b = windowStart(new Date("2026-03-12T10:14:59.999Z"), 900);
    expect(a.getTime()).toBe(b.getTime());
  });

  it("moves to a new bucket exactly on the boundary", () => {
    const last = windowStart(new Date("2026-03-12T10:14:59.999Z"), 900);
    const next = windowStart(new Date("2026-03-12T10:15:00.000Z"), 900);
    expect(next.getTime() - last.getTime()).toBe(900_000);
  });

  it("is exact on an instant that is itself a boundary", () => {
    const boundary = new Date("2026-03-12T10:15:00.000Z");
    expect(windowStart(boundary, 900).getTime()).toBe(boundary.getTime());
  });

  it("handles a 60-second window", () => {
    expect(windowStart(new Date("2026-03-12T10:07:31.482Z"), 60).toISOString()).toBe(
      "2026-03-12T10:07:00.000Z",
    );
  });

  it("works before the epoch rather than rounding towards zero", () => {
    // Needs Math.floor, not Math.trunc.
    const at = new Date("1969-12-31T23:59:30.000Z");
    expect(windowStart(at, 60).toISOString()).toBe("1969-12-31T23:59:00.000Z");
    expect(windowStart(at, 60).getTime()).toBeLessThanOrEqual(at.getTime());
  });

  it("rejects a non-positive or fractional window", () => {
    expect(() => windowStart(new Date(), 0)).toThrow(/positive integer/);
    expect(() => windowStart(new Date(), -60)).toThrow(/positive integer/);
    expect(() => windowStart(new Date(), 1.5)).toThrow(/positive integer/);
  });
});

describe("windowEnd", () => {
  it("is windowStart plus exactly one window", () => {
    const start = windowStart(new Date("2026-03-12T10:07:31.482Z"), 900);
    expect(windowEnd(start, 900).toISOString()).toBe("2026-03-12T10:15:00.000Z");
  });

  it("never overlaps the next window's start", () => {
    const start = windowStart(new Date("2026-03-12T10:07:31.482Z"), 900);
    const nextStart = windowStart(new Date("2026-03-12T10:15:00.000Z"), 900);
    expect(windowEnd(start, 900).getTime()).toBe(nextStart.getTime());
  });
});

describe("RATE_LIMIT_POLICIES", () => {
  it("defines a usable policy for every action", () => {
    for (const action of RATE_LIMIT_ACTIONS) {
      const policy = RATE_LIMIT_POLICIES[action];
      expect(policy.limit).toBeGreaterThan(0);
      expect(Number.isInteger(policy.windowSeconds)).toBe(true);
      expect(policy.windowSeconds).toBeGreaterThan(0);
    }
  });

  /** `/map/data/<layer>` is unauthenticated and writes an audit row per request. */
  it("covers the map with a ceiling that fits a real reader and not a loop", () => {
    const policy = RATE_LIMIT_POLICIES["map-layer"];
    // Six layers on a 5 s tick is 72/min per reader; leave headroom for shared NATs.
    expect(policy.windowSeconds).toBe(60);
    expect(policy.limit).toBeGreaterThanOrEqual(72 * 3);
    expect(policy.limit).toBeLessThan(1000);
  });

  it("keeps the global connector ceiling above the per-user quota", () => {
    // Otherwise one user could exhaust the shared upstream ceiling.
    expect(RATE_LIMIT_POLICIES["connector-global"].limit).toBeGreaterThan(
      RATE_LIMIT_POLICIES["connector-user"].limit,
    );
  });
});

describe("clientSubjectFromHeaders", () => {
  /** Server Component variant of `clientSubject`: first XFF entry only; HMACed before storage. */
  it("takes the first entry and ignores a spoofed prefix", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.7, 203.0.113.99" });
    expect(clientSubjectFromHeaders(headers)).toBe("198.51.100.7");
  });

  it("agrees with the Request form, because they are one implementation", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.7" });
    const request = new Request("https://example.invalid/map", { headers });
    expect(clientSubjectFromHeaders(headers)).toBe(clientSubject(request));
  });

  it("falls back to one shared counter rather than to no counter", () => {
    // Fail closed: unattributable callers share one bucket.
    expect(clientSubjectFromHeaders(new Headers())).toBe("unknown-client");
  });
});
