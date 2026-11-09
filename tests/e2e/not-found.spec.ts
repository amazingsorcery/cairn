import { expect, test } from "@playwright/test";

import { expectNotFoundBody } from "./helpers/dom";

/**
 * The not-found surface: real 404 status, not-found body and `noindex`.
 *
 * A parent `loading.tsx` above a route's existence guard commits a 200 before `notFound()`
 * runs. Don't "fix" that with `dynamicParams = false`; admin-published entries would 404
 * until the next deploy.
 */

const MISSES: { path: string; heading: RegExp }[] = [
  { path: "/tools/does-not-exist", heading: /not found/i },
  { path: "/playbooks/does-not-exist", heading: /not found/i },
  { path: "/tags/does-not-exist", heading: /not found/i },
  { path: "/directory/does-not-exist", heading: /not found/i },
  { path: "/legal/does-not-exist", heading: /not found/i },
  { path: "/live/cameras/does-not-exist", heading: /that camera isn’t in the registry/i },
];

test.describe("not found", () => {
  for (const { path, heading } of MISSES) {
    /** Drafts and missing entries must look identical, or unpublished rows are confirmed. */
    test(`${path} returns 404, renders the not-found body and is noindex`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} must be a real 404`).toBe(404);

      await expectNotFoundBody(page, heading);

      const body = await page.locator("main").innerText();
      expect(body, "a miss must not disclose why").not.toMatch(
        /draft|unpublished|not published|pending review/i,
      );
    });
  }

  test("a path matching no route still returns a real 404", async ({ request }) => {
    const response = await request.get("/definitely-not-a-route");
    expect(response.status()).toBe(404);
  });

  /** The 404 page offers a working search. */
  test("the not-found page offers a route onward that works", async ({ page }) => {
    await page.goto("/tools/does-not-exist");

    const search = page.locator("main").getByRole("searchbox", { name: /search tools and playbooks/i });
    await expect(search).toBeVisible();
    await search.fill("shodan");
    await page.locator("main").getByRole("button", { name: "search", exact: true }).click();

    await page.waitForURL(/\/search\?q=shodan/);
    await expect(page.getByRole("link", { name: /Shodan/ }).first()).toBeVisible();
  });
});
