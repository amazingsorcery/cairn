import { describe, expect, it } from "vitest";

import { countOutboundRequest, tallyOutbound } from "./outbound-tally";

/**
 * QV-09. The audit log's request count has to be right, including under the two conditions
 * that would make a naive module-level counter wrong: a failure part-way through, and two
 * attempts in flight at once.
 */
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
    // A driver that made four requests and then failed made four requests. Recording zero
    // for the attempt that hit the rate limit would be wrong in the direction that hides it.
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
