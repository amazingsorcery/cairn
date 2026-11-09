import { expect, test } from "@playwright/test";

import { countServedH1, settled } from "./helpers/dom";
import { watchOutbound } from "./helpers/net";

/**
 * `/toolbench` smoke tests: each route renders, and no page contacts a third party on load
 * (these tools handle sensitive files and claim to be client-side).
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
    test(`${route} responds and has exactly one h1`, async ({ page, request }) => {
      // `load` doesn't reliably fire for these under the dev server.
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${route} did not return 200`).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      expect(await countServedH1(request, route)).toBe(1);
    });
  }

  /** Blocks as well as records, so a regression doesn't actually leak. */
  test("no toolbench page contacts a third party on load", async ({ page, baseURL }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await settled(page);
      expect(outbound.urls, `${route} contacted a third party on load`).toEqual([]);
    }
  });
});
