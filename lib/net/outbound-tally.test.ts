import { describe, expect, it } from "vitest";

import { countOutboundRequest, tallyOutbound } from "./outbound-tally";

/** The audit count must survive a mid-scope failure and concurrent scopes. */
describe("tallyOutbound", () => {
  it("counts every request made inside the scope, including awaited ones", async () => {
    const result = await tallyOutbound(async () => {
      countOutboundRequest();
      await Promise.all([
        (async () => {
          await Promise.resolve();
          countOutboundRequest();
        })(),
        (async () => {
          countOutboundRequest();
        })(),
      ]);
      return "done";
    });

    expect(result.ok).toBe(true);
    expect(result.outboundRequests).toBe(3);
  });

  it("keeps the count when the scope throws", async () => {
    // Requests made before a failure still count.
    const result = await tallyOutbound(async () => {
      countOutboundRequest();
      countOutboundRequest();
      throw new Error("upstream said no");
    });

    expect(result.ok).toBe(false);
    expect(result.outboundRequests).toBe(2);
  });

  it("does not mix two scopes running at the same time", async () => {
    const slow = tallyOutbound(async () => {
      countOutboundRequest();
      await new Promise((resolve) => setTimeout(resolve, 5));
      countOutboundRequest();
      return "slow";
    });
    const fast = tallyOutbound(async () => {
      for (let i = 0; i < 6; i += 1) countOutboundRequest();
      return "fast";
    });

    const [a, b] = await Promise.all([slow, fast]);
    expect(a.outboundRequests).toBe(2);
    expect(b.outboundRequests).toBe(6);
  });

  it("is a no-op outside a scope, so a script sharing the HTTP path costs nothing", () => {
    expect(() => countOutboundRequest()).not.toThrow();
  });
});
