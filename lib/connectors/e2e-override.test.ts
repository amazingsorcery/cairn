import { afterEach, describe, expect, it } from "vitest";

import { e2eOverride } from "./e2e-override";

/**
 * The production guard on the E2E state override.
 *
 * This is the one part of that module that has to be right. Everything else it does is a
 * convenience for tests; this is the line that stops a test hook becoming a way to switch a
 * live surface off, or to feed a reader fabricated data on a page whose entire value is that
 * its data is real.
 */

const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_STATE = process.env.E2E_CONNECTOR_STATE;

function setEnv(nodeEnv: string | undefined, state: string | undefined): void {
  // `NODE_ENV` is typed readonly in @types/node; this is a test fixture, not production code.
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  (process.env as Record<string, string | undefined>).E2E_CONNECTOR_STATE = state;
}

afterEach(() => setEnv(ORIGINAL_ENV, ORIGINAL_STATE));

describe("e2eOverride", () => {
  it("is inert in production even with a valid override set", () => {
    setEnv("production", JSON.stringify({ "adsb-lol": { reason: "disabled" } }));
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("is inert in production for a forced payload too", () => {
    setEnv("production", JSON.stringify({ "adsb-lol": { data: { aircraft: [] } } }));
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("returns the degraded envelope outside production", () => {
    setEnv("test", JSON.stringify({ "adsb-lol": { reason: "rate-limited" } }));
    const envelope = e2eOverride("adsb-lol", "Data from adsb.lol");
    expect(envelope?.state).toBe("unavailable");
    expect(envelope?.reason).toBe("rate-limited");
    expect(envelope?.data).toBeNull();
    expect(envelope?.attribution).toBe("Data from adsb.lol");
  });

  it("ignores a connector it was not asked about", () => {
    setEnv("test", JSON.stringify({ "some-other": { reason: "disabled" } }));
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("ignores malformed JSON rather than throwing", () => {
    // A typo must not be able to take a live surface down.
    setEnv("test", "{not json");
    expect(() => e2eOverride("adsb-lol", null)).not.toThrow();
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("ignores a reason that is not one of the five", () => {
    setEnv("test", JSON.stringify({ "adsb-lol": { reason: "made-up" } }));
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("is inert when the variable is absent", () => {
    setEnv("test", undefined);
    expect(e2eOverride("adsb-lol", null)).toBeNull();
  });

  it("dates a forced payload by ageSeconds so the stale boundary is drivable", () => {
    setEnv("test", JSON.stringify({ "adsb-lol": { data: { aircraft: [] }, ageSeconds: 90 } }));
    const now = new Date("2026-08-31T12:00:00.000Z");
    const envelope = e2eOverride("adsb-lol", null, now);
    expect(envelope?.state).toBe("fresh");
    expect(envelope?.fetchedAt?.toISOString()).toBe("2026-08-31T11:58:30.000Z");
  });
});
