import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEGRADED_REASONS,
  describeDegraded,
  envelopeAgeSeconds,
  formatAge,
  madeARequest,
  parseEnvelope,
  type DegradedReason,
  type LookupOutcome,
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

/**
 * Added with the merge of `lib/toolbench/lookup.ts` into this module.
 */
describe("the reason vocabulary mirrors the server's, and is checked rather than remembered", () => {
  it("has exactly the members of DegradedReason in lib/connectors/types.ts", () => {
    /**
     * The list is duplicated rather than imported because `lib/connectors/` throws on load in
     * a browser bundle by design, and these values are needed by Client Components. So the
     * duplication is asserted here instead: the source of truth is read out of the TypeScript
     * file itself, so adding a seventh reason on the server and forgetting it here fails this
     * test rather than silently rendering a blank panel for a state that now exists.
     */
    const source = readFileSync(join(process.cwd(), "lib", "connectors", "types.ts"), "utf8");
    const block = /export type DegradedReason =([\s\S]*?);/.exec(source);
    expect(block, "DegradedReason is no longer declared as a union in types.ts").not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...DEGRADED_REASONS].sort());
  });

  it("gives every reason a title, a detail and a retryable verdict", () => {
    for (const reason of DEGRADED_REASONS) {
      const copy = describeDegraded(reason);
      expect(copy.title.length, reason).toBeGreaterThan(8);
      // The detail is what a reader acts on, so it has to be a sentence rather than a label.
      expect(copy.detail.length, reason).toBeGreaterThan(80);
      expect(typeof copy.retryable, reason).toBe("boolean");
    }
  });

  it("does not invite a retry of a refusal the upstream already made", () => {
    // The one distinction that changes behaviour rather than wording: retrying a rate limit
    // is asking a service that has said no, which product-brief §3.2 constraint 5 forbids.
    expect(describeDegraded("rate-limited").retryable).toBe(false);
    expect(describeDegraded("disabled").retryable).toBe(false);
    // Ours to fix, so retrying is exactly right.
    expect(describeDegraded("bad-request").retryable).toBe(true);
    expect(describeDegraded("upstream-down").retryable).toBe(true);
  });

  it("tells the reader that an upstream failure is not an absence of data", () => {
    // The regression this pins: crt.sh returned 404 for a domain with 4,375 logged
    // certificates and the page said none existed. Whatever the wording becomes, a failed
    // lookup must never read as a negative result.
    expect(describeDegraded("upstream-down").detail).toMatch(/not a result/i);
  });

  it("parses a bad-request envelope off the wire", () => {
    const parsed = parseEnvelope({
      state: "unavailable",
      fetchedAt: null,
      data: null,
      attribution: null,
      reason: "bad-request",
      message: "That is not a valid domain name.",
      connector: "crt-sh",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.reason).toBe("bad-request");
  });
});

describe("LookupOutcome", () => {
  const failure = (reason: DegradedReason): LookupOutcome<string> => ({
    status: "unavailable",
    reason,
    message: "m",
    attribution: null,
  });

  it("knows which refusals never reached a third party", () => {
    // A page that says "the source is unavailable" when no source was contacted is telling
    // the reader something false about somebody else.
    expect(madeARequest(failure("bad-request"))).toBe(false);
    expect(madeARequest(failure("disabled"))).toBe(false);
    expect(madeARequest(failure("quota-exhausted"))).toBe(false);

    expect(madeARequest(failure("upstream-down"))).toBe(true);
    expect(madeARequest(failure("rate-limited"))).toBe(true);
    expect(
      madeARequest({
        status: "ok",
        data: "x",
        fetchedAt: "2026-09-01T00:00:00.000Z",
        stale: false,
        attribution: null,
        note: null,
      }),
    ).toBe(true);
  });
});
