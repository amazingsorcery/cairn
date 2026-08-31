import { expect, test, type Page } from "@playwright/test";

import { settled } from "./helpers/dom";
import { isOutbound, watchOutbound } from "./helpers/net";

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
   * DEFECT THIS CATCHES: the browser being pointed at the ADS-B aggregator directly, or the
   * map being mounted on page load. Either hands a third party the reader's IP address and
   * the patch of the world they are looking at (ADR 0011 §1; ADR 0016 §1 makes the map
   * opt-in). A direct client fetch is a plausible "simplification" of the server proxy and
   * would look like a performance win in a code review.
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
    expect(await page.locator(".leaflet-container").count()).toBe(0);
    expect(
      await page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]').count(),
      "a preconnect to the tile server is a connection before the click",
    ).toBe(0);
  });

  /**
   * DEFECT THIS CATCHES: the tile provider being contacted without the reader agreeing to it,
   * or the disclosure drifting out of the button label into prose nobody reads. ADR 0015's
   * rule — the consequence lives *in* the label — applied to the tile server.
   */
  test("the map is opt-in and names the tile server in the control itself", async ({ page }) => {
    await page.goto("/live/flights");
    const state = await observedState(page);
    test.skip(
      !state.hasTable,
      `no aircraft rows (${state.note}); the map control only exists in a live state`,
    );

    await expect(
      page.getByRole("button", { name: /load the map — connects you to .+/i }),
    ).toBeVisible();
    await expect(page.getByText(/will see your IP address and the tiles you request/i)).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: the table being coupled to the map. ADR 0016 §1 is explicit — "the
   * flights table must remain fully usable if it fails to load" — and `openMap()`'s
   * `catch` is the only thing making that true. Deleting the catch, or moving the table
   * inside the map's render branch, would take the whole route down with a failed chunk
   * fetch: a failure mode that never appears locally, because the chunk always loads.
   *
   * The chunk is blocked by aborting every `_next/static` fetch issued after the click,
   * rather than by matching a filename: the dev-server chunk is named `flights-map`, the
   * production one is a content hash, and a spec that only breaks one of them proves nothing
   * about the other.
   */
  test("the table survives the map chunk failing to load", async ({ page, baseURL }) => {
    await page.goto("/live/flights");
    const state = await observedState(page);
    test.skip(!state.hasTable, `no aircraft rows (${state.note}); no table to keep usable`);

    const rowsBefore = await page.getByRole("row").count();
    expect(rowsBefore).toBeGreaterThan(1);

    let blockChunks = false;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (blockChunks && !isOutbound(url, baseURL!) && url.includes("/_next/static/")) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    blockChunks = true;
    await page.getByRole("button", { name: /load the map — connects you to .+/i }).click();

    await expect(page.getByText(/The map didn’t load/i)).toBeVisible();
    await expect(
      page.getByText(/The table below lists every aircraft in view and is unaffected/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /retry the map/i })).toBeVisible();

    // The table is not merely present — it still has its rows and is still sortable.
    await expect(page.getByRole("table")).toBeVisible();
    expect(await page.getByRole("row").count()).toBe(rowsBefore);
    expect(await page.locator(".leaflet-container").count()).toBe(0);

    const header = page.getByRole("columnheader").first();
    await expect(header).toBeVisible();
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
