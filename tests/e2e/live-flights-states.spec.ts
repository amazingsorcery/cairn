import { expect, test } from "@playwright/test";

import { settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/live/flights` forced into specific states via `E2E_CONNECTOR_STATE`
 * (`lib/connectors/e2e-override.ts`), which replaces the whole call: no fetch, quota or audit
 * row. The hook never fires when NODE_ENV is production.
 *
 * The server reads the variable at startup, so each test skips unless the server was started
 * with its state, e.g. `E2E_CONNECTOR_STATE='{"reason":"disabled"}' pnpm test:e2e`.
 */

/** What the server was told to pretend, if anything. Mirrors the variable CI would set. */
const FORCED = process.env.E2E_CONNECTOR_STATE ?? "";

function forcing(reason: string): boolean {
  return FORCED.includes(`"reason"`) && FORCED.includes(reason);
}

test.describe("live flights — forced states", () => {
  test.skip(({ isMobile }) => isMobile === true, "state copy is not width-dependent");

  /** `disabled` is a decision, not a fault: no retry button, no spinner, no outbound call. */
  test("disabled renders the switched-off copy and makes no call", async ({ page, baseURL }) => {
    test.skip(!forcing("disabled"), "server not started with the disabled state forced");

    const outbound = await watchOutbound(page, baseURL!, { block: true });
    await page.goto("/live/flights");

    // By role: the text also appears in the freshness bar and the sr-only live region.
    await expect(
      page.getByRole("heading", { name: "Flight tracking is switched off", level: 2 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /about our sources/i })).toBeVisible();

    await settled(page);
    expect(outbound.urls).toEqual([]);
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });

  /** After an upstream refusal the client must stop polling; retrying would breach its limits. */
  test("rate-limited says the upstream refused us, and stops polling", async ({
    page,
    baseURL,
  }) => {
    test.skip(!forcing("rate-limited"), "server not started with the rate-limited state forced");

    const outbound = await watchOutbound(page, baseURL!, { block: true });
    const ownCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/live/flights")) ownCalls.push(request.url());
    });

    await page.goto("/live/flights");
    await expect(
      page.getByRole("heading", { name: "Aircraft positions paused", level: 2 }),
    ).toBeVisible();
    await settled(page);

    expect(outbound.urls, "nothing leaves for the aggregator").toEqual([]);
    expect(ownCalls, "and the client must not poll our own proxy either").toEqual([]);
  });

  /** Stale data stays visible with its age; no refresh spinner. */
  test("stale keeps the data on screen and says how old it is", async ({ page }) => {
    test.skip(!forcing("stale"), "server not started with the stale state forced");

    await page.goto("/live/flights");

    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText(/These positions are \d+ seconds old/)).toBeVisible();
    await expect(page.getByText(/Aircraft have moved since/)).toBeVisible();
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });

  /** This route has a table only; the map lives on `/map`. */
  test("no map is mounted, and the table is complete, with a forced payload", async ({ page }) => {
    test.skip(!FORCED.includes(`"data"`), "server not started with a forced flights payload");

    await page.goto("/live/flights");
    await expect(page.getByRole("table")).toBeVisible();
    expect(await page.getByRole("row").count()).toBeGreaterThan(1);

    expect(await page.locator(".leaflet-container, .maplibregl-map").count()).toBe(0);
    expect(await page.locator("canvas").count()).toBe(0);

    const link = page.getByRole("link", { name: /open the live map/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/map");
  });
});
