import { expect, test, type Page } from "@playwright/test";

import { settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/live/flights` — ADR 0011, ADR 0014, ADR 0016 §1.
 *
 * THE UPSTREAM IS NOT PART OF THE SYSTEM UNDER TEST, AND CANNOT BE INTERCEPTED FROM HERE.
 * `api.adsb.lol` is queried **by our server** — that is the whole point of ADR 0011 §1, and
 * `lib/connectors/runtime.ts` throws at module load if it is ever bundled for a browser. A
 * Playwright route handler sees browser traffic only, so there is no interception point.
 *
 * What the suite does instead:
 *   · it never *causes* upstream traffic — every spec here blocks all cross-origin requests;
 *   · every assertion is written to hold in whichever state the page came back in — `fresh`,
 *     `stale`, or any of the `unavailable` reasons (`upstream-down`, `quota-exhausted`,
 *     `rate-limited`, `disabled`);
 *   · the two assertions that are meaningless without aircraft rows skip with the observed
 *     state named, rather than flaking.
 *
 * The per-user quota is now 3/minute against a 6/minute global ceiling, so a full suite run
 * will legitimately drive this route into `quota-exhausted` or `rate-limited` and those two
 * will skip. That is the honest outcome; `docs/qa/e2e.md` §3 records what it costs and what
 * would fix it.
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
   * DEFECT THIS CATCHES: the browser being pointed at the ADS-B aggregator directly, or a map
   * being mounted on page load. Either hands a third party the reader's IP address and the
   * patch of the world they are looking at (ADR 0011 §1). A direct client fetch is a
   * plausible "simplification" of the server proxy and would look like a performance win in
   * a code review.
   *
   * This route draws no map at all since 2026-09-01 — `/map` is the only map, and
   * `components/live/flights-map.tsx` is deleted. Both the Leaflet and the MapLibre container
   * classes are asserted absent, so re-adding a map here under either engine fails the test
   * rather than quietly duplicating `/map`.
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

  /**
   * DEFECT THIS CATCHES: a second aircraft map growing back on this route.
   *
   * This page carried its own opt-in Leaflet map until 2026-09-01. `/map` draws the same feed
   * on MapLibre + deck.gl with a table equivalent, freshness reporting and degraded states, so
   * the one here was the same feature maintained twice — and it rotted silently when the tile
   * config moved from raster to vector, rendering an empty box that threw no error. The
   * replacement is a plain link, and this asserts the link is real and reaches a real page.
   */
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

  /**
   * DEFECT THIS CATCHES: a refresh spinner. ADR 0014 §8 and `states.md` §0 allow exactly two
   * spinners in the whole product, and a background refresh is not one of them — the honest
   * rendering is the current data with its age counting up. A spinner here asserts that fresh
   * data is arriving, which during an upstream outage is a false claim on an evidence surface.
   */
  test("the coverage caveat and the freshness state are always rendered, never a spinner", async ({
    page,
  }) => {
    await page.goto("/live/flights");
    await expect(page.getByRole("heading", { level: 1, name: /flights/i })).toBeVisible();

    // Always present, never collapsed — `states.md` §5.1. An absence is not evidence.
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
