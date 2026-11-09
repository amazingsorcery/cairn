import { expect, test, type Page } from "@playwright/test";

import { settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/live/flights`. The upstream is called by our server, so Playwright can't intercept it.
 * These assertions hold in any state (fresh, stale, or unavailable); tests that need aircraft
 * rows skip with the observed state. With a 3/min per-user quota, a full run often lands in
 * `quota-exhausted` or `rate-limited`. See live-flights-states.spec.ts for forced states.
 */

/** Whatever the page is showing: the table, or the degraded block's title. */
async function observedState(page: Page): Promise<{ hasTable: boolean; note: string }> {
  if ((await page.getByRole("table").count()) > 0) return { hasTable: true, note: "table" };
  for (const title of [
    "Aircraft positions unavailable",
    "Aircraft positions paused",
    "Flight tracking is switched off",
    "No aircraft in this area",
  ]) {
    if ((await page.getByText(title, { exact: true }).count()) > 0) {
      return { hasTable: false, note: title };
    }
  }
  return { hasTable: false, note: "no table and no recognised degraded state" };
}

test.describe("live flights", () => {
  /**
   * The browser must not contact the aggregator or a tile server (that would share the
   * reader's IP and viewport). No map of either engine on this route.
   */
  test("nothing leaves for a third party on load, and no map is mounted", async ({
    page,
    baseURL,
  }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    await page.goto("/live/flights");
    await expect(page.getByRole("heading", { level: 1, name: /flights/i })).toBeVisible();
    await settled(page);

    expect(outbound.urls, "aircraft positions come from our server, never the browser").toEqual(
      [],
    );
    expect(await page.locator(".leaflet-container, .maplibregl-map").count()).toBe(0);
    expect(
      await page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]').count(),
      "a preconnect to the tile server is a connection this route never needs to make",
    ).toBe(0);
  });

  /** The page links to `/map` instead of drawing its own map. */
  test("the map lives on /map, and this page says so with a working link", async ({ page }) => {
    await page.goto("/live/flights");
    const state = await observedState(page);
    test.skip(
      !state.hasTable,
      `no aircraft rows (${state.note}); the map pointer only renders in a live state`,
    );

    const link = page.getByRole("link", { name: /open the live map/i });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/map");

    await link.click();
    await expect(page).toHaveURL(/\/map$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  /** No refresh spinner: show current data with its age instead. */
  test("the coverage caveat and the freshness state are always rendered, never a spinner", async ({
    page,
  }) => {
    await page.goto("/live/flights");
    await expect(page.getByRole("heading", { level: 1, name: /flights/i })).toBeVisible();

    // Coverage caveat is always shown.
    await expect(
      page.getByText(/an aircraft absent from this page is not evidence it is not flying/i),
    ).toBeVisible();

    await settled(page);
    expect(
      await page.locator('[role="progressbar"], .animate-spin').count(),
      "there is no spinner on this route outside the first-load boundary",
    ).toBe(0);
  });
});
