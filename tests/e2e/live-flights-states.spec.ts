import { expect, test } from "@playwright/test";

import { settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/live/flights` driven into a known state — ADR 0011 rule 5, ADR 0014, and architecture
 * HANDOFF §11 assertion 21: "the stale and unavailable states are **reachable in tests**, not
 * just theoretically implemented".
 *
 * `live-flights.spec.ts` asserts what holds whatever the upstream did. This file asserts the
 * states themselves, by forcing them through `E2E_CONNECTOR_STATE` (`lib/connectors/e2e-override.ts`),
 * which stands in for the whole call: nothing is fetched, no quota is consumed, no audit row
 * is written. **The hook cannot fire when `NODE_ENV === "production"`** — that is checked
 * before the variable is read, and there is no flag that re-enables it.
 *
 * WHY THIS IS A SEPARATE FILE. The variable is read by the **server**, so it has to be set
 * before the server starts; it cannot be toggled per test from inside the browser. These
 * tests therefore skip unless the server was started with the state they need, and
 * `docs/qa/e2e.md` §1 carries the command. Keeping them apart from the observational file
 * means the ordinary run is not full of skips, and a CI job that wants this coverage runs
 * this file with the variable set.
 */

/** What the server was told to pretend, if anything. Mirrors the variable CI would set. */
const FORCED = process.env.E2E_CONNECTOR_STATE ?? "";

function forcing(reason: string): boolean {
  return FORCED.includes(`"reason"`) && FORCED.includes(reason);
}

test.describe("live flights — forced states", () => {
  test.skip(({ isMobile }) => isMobile === true, "state copy is not width-dependent");

  /**
   * DEFECT THIS CATCHES: the kill-switch rendering as an error, a spinner, or an empty
   * region instead of saying a human switched it off. `states.md` §5 and ADR 0011 rule 5:
   * `disabled` is a decision somebody made, not a fault, and the copy has to say so — with
   * **no retry button**, because there is nothing for the reader to retry.
   *
   * Also asserts the guarantee that makes the state meaningful: no outbound request is made.
   */
  test("disabled renders the switched-off copy and makes no call", async ({ page, baseURL }) => {
    test.skip(!forcing("disabled"), "server not started with the disabled state forced");

    const outbound = await watchOutbound(page, baseURL!, { block: true });
    await page.goto("/live/flights");

    // By role, not by text: the title also appears in the freshness bar and in the route's
    // sr-only live region, so a bare text match is three elements and a strict-mode error.
    await expect(
      page.getByRole("heading", { name: "Flight tracking is switched off", level: 2 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /about our sources/i })).toBeVisible();

    await settled(page);
    expect(outbound.urls).toEqual([]);
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });

  /**
   * DEFECT THIS CATCHES: the client continuing to poll after the upstream refused us.
   * `rate-limited` is the one reason where continuing to call is a **breach of
   * product-brief §3.2 constraint 5** ("respect robots.txt, ToS and rate limits"), not merely
   * futile — so it is the one degraded state where a polite retry loop is itself the defect.
   */
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

  /**
   * DEFECT THIS CATCHES: a stale payload being presented as current. ADR 0014 §1 — the age is
   * the one number on a Live page that must never be wrong — and §8: a background refresh
   * never shows a spinner, because the honest rendering is the data that is here with its age
   * counting up.
   */
  test("stale keeps the data on screen and says how old it is", async ({ page }) => {
    test.skip(!forcing("stale"), "server not started with the stale state forced");

    await page.goto("/live/flights");

    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText(/These positions are \d+ seconds old/)).toBeVisible();
    await expect(page.getByText(/Aircraft have moved since/)).toBeVisible();
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });

  /**
   * DEFECT THIS CATCHES: an aircraft map growing back on this route.
   *
   * ADR 0016 §1 made the table primary and the map an opt-in extra here. `/map` has since
   * become the map — same feed, MapLibre + deck.gl, its own table equivalent — so the extra
   * was deleted on 2026-09-01 rather than maintained twice. This spec used to prove the table
   * survived the map chunk failing; there is no map chunk on this route now, and the stronger
   * assertion is that no map is mounted at all, with a complete table and a real pointer to
   * where the map is. Written against a forced payload, so it runs every time rather than
   * only when the upstream happens to return aircraft.
   */
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
