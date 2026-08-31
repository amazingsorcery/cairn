import { expect, test } from "@playwright/test";

import { expectNotFoundBody } from "./helpers/dom";

/**
 * The not-found surface — architecture HANDOFF §11 assertion 3, `states.md` §1.2.
 *
 * **THE STATUS CODE IS NOT ASSERTED, AND THAT IS DELIBERATE.** Integration finding **I-15**:
 * in this Next version (15.5.24) `notFound()` returns **HTTP 200** with the correct not-found
 * body, on every route shape — SSG with `dynamicParams`, plain SSG, and `force-dynamic` alike
 * — reproduced against a production build with a real seeded database. A genuinely unmatched
 * path still returns a true 404.
 *
 * It was investigated and downgraded rather than fixed: the obvious lever
 * (`dynamicParams = false`) would make an entry published through the admin UI 404 until the
 * next redeploy, which for a content product with an editorial workflow is a worse defect
 * than the one it fixes. The SEO harm is already neutralised, because the not-found pages
 * emit `<meta name="robots" content="noindex, nofollow">`; what remains is monitoring
 * fidelity, which is operational.
 *
 * So this file asserts **what a reader and a crawler actually receive**: the not-found body,
 * and the `noindex` tag. Asserting `404` would fail on a correctly-behaving build, which is
 * worse than no assertion — it invites someone to "fix" it with the change that breaks
 * publishing. Add the status assertion back on a Next.js upgrade and delete this note.
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
    test(`${path} renders the not-found body and is noindex`, async ({ page }) => {
      await page.goto(path);
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
