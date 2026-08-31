import { expect, test } from "@playwright/test";

import { expectNotFoundBody } from "./helpers/dom";

/**
 * The not-found surface — architecture HANDOFF §11 assertion 3, `states.md` §1.2.
 *
 * **ON THE STATUS CODE — read this before changing these assertions.** Integration finding
 * **I-15** recorded that `notFound()` returned **HTTP 200** with the correct not-found body
 * on every route shape, reproduced against a production build with a real seeded database.
 * This file was written to assert only the body and the `noindex` tag, because a `404`
 * assertion would have failed on a build that was behaving as designed, and because the
 * obvious lever (`dynamicParams = false`) makes an entry published through the admin UI 404
 * until the next redeploy — a worse defect than the one it fixes.
 *
 * **I-15 is now closed** (`d3d86f2`, `753cf1a`). The cause was a parent `loading.tsx` whose
 * Suspense boundary wrapped the child segment *above* its existence guard, so the response
 * shell — and the 200 — was committed before the guard ran. Every shape below now returns a
 * real 404, verified against this build, so the status **is** asserted again.
 *
 * The body and `noindex` assertions stay alongside it. They are what a reader and a crawler
 * actually receive, they held throughout the period when the status did not, and if this
 * regresses they are what will still be true — which is exactly the distinction the next
 * person will need.
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
    /**
     * DEFECT THIS CATCHES: a miss rendering a blank page, an unhandled error, or — worst —
     * a page that distinguishes "draft" from "never existed". `states.md` §1.2: "For a draft
     * or removed entry the 404 is the same page. It must not distinguish 'never existed' from
     * 'not published' — that would confirm the existence of unpublished rows."
     */
    test(`${path} returns 404, renders the not-found body and is noindex`, async ({ page }) => {
      const response = await page.goto(path);
      // A 200 here is I-15 regressing: uptime monitoring and log analysis can no longer tell
      // a miss from a hit, and a crawler is told the page is real content.
      expect(response?.status(), `${path} must be a real 404`).toBe(404);

      await expectNotFoundBody(page, heading);

      const body = await page.locator("main").innerText();
      expect(body, "a miss must not disclose why").not.toMatch(
        /draft|unpublished|not published|pending review/i,
      );
    });
  }

  /**
   * DEFECT THIS CATCHES: the router-level 404 losing its status — the one case that does
   * return a true 404 today and therefore the one that can regress into the I-15 behaviour
   * everywhere. If this ever starts returning 200, the whole not-found surface has become
   * indistinguishable from a hit in the access log.
   */
  test("a path matching no route still returns a real 404", async ({ request }) => {
    const response = await request.get("/definitely-not-a-route");
    expect(response.status()).toBe(404);
  });

  /**
   * DEFECT THIS CATCHES: a not-found page with no way onward. `states.md` §0 — "an error with
   * no next action is a dead end" — and this page is where a reader lands after a stale link
   * from someone else's article, which is a moment the product cannot afford to waste.
   */
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
