import { expect, test } from "@playwright/test";

import { countServedH1, settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/toolbench` — the client-side tools.
 *
 * A smoke spec, and deliberately only that. These routes were verified by the tools-engineer
 * against a dev server; what nothing had checked was whether they survive a request at all
 * from outside that session, and whether they keep the promise that makes them safe to use on
 * investigation material.
 *
 * THE PRIVACY ASSERTION IS THE POINT. A metadata scrubber or an EXIF reader that quietly
 * posts the file somewhere is the single worst thing this product could ship: the audience
 * (product-brief §4) is handling material whose *existence* is sensitive, and product-brief
 * §3.2 forbids third-party analytics outright. "Client-side" is a claim, and this is the
 * check that it is true on page load.
 */

const ROUTES = [
  "/toolbench",
  "/toolbench/coordinates",
  "/toolbench/hashes-and-encodings",
  "/toolbench/image-metadata",
  "/toolbench/metadata-scrubber",
  "/toolbench/reverse-image-search",
  "/toolbench/sun-position",
  "/toolbench/timestamps",
];

test.describe("toolbench", () => {
  for (const route of ROUTES) {
    /**
     * DEFECT THIS CATCHES: a route that renders in the dev session it was built in and 500s
     * or 404s for everyone else — a missing `generateStaticParams`, a server-only import
     * pulled into a client component, an env var read at module scope. All of them look fine
     * to the person who just wrote the page.
     */
    test(`${route} responds and has exactly one h1`, async ({ page, request }) => {
      const response = await page.goto(route);
      expect(response?.status(), `${route} did not return 200`).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      expect(await countServedH1(request, route)).toBe(1);
    });
  }

  /**
   * DEFECT THIS CATCHES: a tool that is described as client-side but is not. Any request to
   * a third-party origin from these pages — an analytics beacon, a font CDN, a geocoding API
   * called on load — breaks the promise the whole surface rests on, and none of it is visible
   * in the UI.
   *
   * Blocking as well as recording, for the same reason as the camera specs: a recorder alone
   * proves the request was attempted while still letting it happen, which for a privacy
   * assertion means the test has already done the thing it is asserting nobody does.
   */
  test("no toolbench page contacts a third party on load", async ({ page, baseURL }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await settled(page);
      expect(outbound.urls, `${route} contacted a third party on load`).toEqual([]);
    }
  });
});
