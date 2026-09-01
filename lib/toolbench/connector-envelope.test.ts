import { describe, expect, it } from "vitest";

import {
  DEGRADED_REASONS,
  describeDegraded,
  envelopeAgeSeconds,
  formatAge,
  parseEnvelope,
} from "./connector-envelope";

const wellFormed = {
  state: "fresh",
  fetchedAt: "2026-09-01T10:00:00.000Z",
  data: { anything: true },
  attribution: "Some source",
  reason: null,
  message: null,
  connector: "example",
};

describe("envelope parsing", () => {
  it("accepts the shape the route handlers return", () => {
    const result = parseEnvelope(wellFormed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.connector).toBe("example");
  });

  it("accepts every degraded reason the connector runtime can produce", () => {
    for (const reason of DEGRADED_REASONS) {
      const result = parseEnvelope({
        ...wellFormed,
        state: "unavailable",
        data: null,
        reason,
        message: "…",
      });
      expect(result.ok, reason).toBe(true);
    }
  });

  /**
   * A reason the client does not know about must not be silently rendered as "everything is
   * fine". It fails the parse, and the copy for a failed parse says the fault is ours.
   */
  it("refuses a reason it does not have copy for", () => {
    const result = parseEnvelope({ ...wellFormed, reason: "something-new" });
    expect(result.ok).toBe(false);
  });

  it("refuses an error page, an empty body and a null", () => {
    expect(parseEnvelope("<html>500</html>").ok).toBe(false);
    expect(parseEnvelope({}).ok).toBe(false);
    expect(parseEnvelope(null).ok).toBe(false);
  });
});

describe("degraded copy", () => {
  it("has distinct copy for every reason", () => {
    const titles = DEGRADED_REASONS.map((reason) => describeDegraded(reason).title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const reason of DEGRADED_REASONS) {
      expect(describeDegraded(reason).detail.length, reason).toBeGreaterThan(80);
    }
  });

  /**
   * The two that must not invite a retry. `rate-limited` means the upstream has already
   * refused us and a cooldown is open; `disabled` means nobody turned it on. Offering a
   * retry button on either is inviting a reader to hammer a service that said no, or to
   * repeat a request that will never leave the building.
   */
  it("marks rate-limited and disabled as not retryable, and the rest as retryable", () => {
    expect(describeDegraded("rate-limited").retryable).toBe(false);
    expect(describeDegraded("disabled").retryable).toBe(false);
    expect(describeDegraded("upstream-down").retryable).toBe(true);
    expect(describeDegraded("quota-exhausted").retryable).toBe(true);
    expect(describeDegraded("stale").retryable).toBe(true);
  });

  /**
   * The distinction the whole vocabulary exists for. Merging these two sends an operator,
   * and a reader, to the wrong remedy — one is our ceiling, the other is theirs.
   */
  it("does not describe our own ceiling and the upstream's refusal the same way", () => {
    const ours = describeDegraded("quota-exhausted");
    const theirs = describeDegraded("rate-limited");
    expect(ours.title).not.toBe(theirs.title);
    expect(ours.retryable).not.toBe(theirs.retryable);
  });
});

describe("age", () => {
  const now = new Date("2026-09-01T10:05:00.000Z");

  it("counts seconds from the upstream response time", () => {
    expect(envelopeAgeSeconds("2026-09-01T10:00:00.000Z", now)).toBe(300);
    expect(envelopeAgeSeconds("2026-09-01T10:04:58.000Z", now)).toBe(2);
  });

  it("never reports a negative age when the clocks disagree", () => {
    expect(envelopeAgeSeconds("2026-09-01T10:06:00.000Z", now)).toBe(0);
  });

  it("returns null when nothing was ever fetched, or the timestamp is unreadable", () => {
    expect(envelopeAgeSeconds(null, now)).toBeNull();
    expect(envelopeAgeSeconds("not a date", now)).toBeNull();
  });

  it("renders an age a reader can act on", () => {
    expect(formatAge(null)).toBe("never fetched");
    expect(formatAge(2)).toBe("just now");
    expect(formatAge(40)).toBe("40 seconds ago");
    expect(formatAge(300)).toBe("5 minutes ago");
    expect(formatAge(7200)).toBe("2 hours ago");
  });
});
