import { expect, test } from "@playwright/test";

import { settled } from "./helpers/dom";

/**
 * `/directory` filters: all filter state lives in the URL, so views are shareable and
 * back/forward work.
 */

/** The desktop facet sidebar. `<aside aria-labelledby="directory-filters-heading">`. */
function sidebar(page: import("@playwright/test").Page) {
  return page.getByRole("complementary", { name: /filters/i });
}

test.describe("directory filters", () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    "the facet sidebar is hidden below md:; the mobile path is covered by the sheet spec",
  );

  test("ticking a facet writes it to the URL, and back/forward restore the checkbox", async ({
    page,
  }) => {
    await page.goto("/directory");
    // A tick before hydration would be overwritten by the first client render.
    await settled(page);

    const free = sidebar(page).getByRole("checkbox", { name: "free", exact: true });
    await expect(free).not.toBeChecked();

    const unfilteredCount = await page.getByText(/^\d+ tools · sorted by/).innerText();

    await free.check();
    await expect(page).toHaveURL(/[?&]cost=free(&|$)/);
    await expect(free).toBeChecked();

    const filteredCount = await page.getByText(/^\d+ tools · sorted by/).innerText();
    expect(filteredCount).not.toBe(unfilteredCount);

    // Back: the checkbox re-syncs from the URL.
    await page.goBack();
    await expect(page).toHaveURL(/\/directory$/);
    await expect(free).not.toBeChecked();
    await expect(page.getByText(/^\d+ tools · sorted by/)).toHaveText(unfilteredCount);

    // Forward.
    await page.goForward();
    await expect(page).toHaveURL(/[?&]cost=free(&|$)/);
    await expect(free).toBeChecked();
  });

  test("a filtered URL is shareable and reproduces its own checkbox state", async ({ page }) => {
    // camelCase values, which a lowercasing parser would drop.
    await page.goto("/directory?confidence=needsReview&cost=freeWithRegistration");

    await expect(
      sidebar(page).getByRole("checkbox", { name: "needs review", exact: true }),
    ).toBeChecked();
    await expect(
      sidebar(page).getByRole("checkbox", { name: "free with registration", exact: true }),
    ).toBeChecked();

    // Match the chip's screen-reader suffix; the empty state has similar "remove" links.
    await expect(
      page.getByRole("link", { name: /^confidence: needs review — remove this filter$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^cost: free with registration — remove this filter$/i }),
    ).toBeVisible();
  });

  /** The empty state names the removal that widens results most, with a measured count. */
  test("zero results names a filter to remove, with the count that removal would yield", async ({
    page,
  }) => {
    await page.goto("/directory?cost=enterprise&category=archives-and-historical");

    await expect(
      page.getByRole("heading", { name: /no tools match these filters/i }),
    ).toBeVisible();
    await expect(page.getByText(/2 filters are active\./)).toBeVisible();
    await expect(page.getByText(/Removing .+ widens this the most — \d+ tools? match/)).toBeVisible();

    const remove = page.getByRole("link", { name: /^remove / });
    await expect(remove).toBeVisible();
    await remove.click();

    // The named removal actually widens the result set.
    await expect(page.getByText(/^[1-9]\d* tools? · sorted by/)).toBeVisible();
  });

  /** End-to-end counterpart to the round-trip tests in `filter-url.test.ts`. */
  test("clear all returns to a bare /directory", async ({ page }) => {
    await page.goto("/directory?cost=free&confidence=verified&sort=name");
    await expect(page.getByRole("link", { name: /cost: free/i })).toBeVisible();

    await page.getByRole("link", { name: "clear all", exact: true }).click();

    await expect(page).toHaveURL(/\/directory$/);
    await expect(page.getByRole("link", { name: /cost: free/i })).toHaveCount(0);
  });
});

test.describe("directory filters at 375px", () => {
  test.skip(({ isMobile }) => isMobile !== true, "the sheet only exists below md:");

  /** The sheet's facets push the URL while open, so its "show N tools" count updates. */
  test("the sheet opens, a facet ticks, and the result count updates", async ({ page }) => {
    await page.goto("/directory");
    await settled(page);

    await page.getByRole("button", { name: /^filters/ }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/Every filter is written into the address/)).toBeVisible();

    const before = await page.getByText(/^\d+ tools · sorted by/).innerText();
    const showAll = await sheet.getByRole("button", { name: /^show \d+ tools?$/ }).innerText();

    await sheet.getByRole("checkbox", { name: "free", exact: true }).check();

    await expect(page).toHaveURL(/[?&]cost=free(&|$)/);
    await expect(page.getByText(/^\d+ tools · sorted by/)).not.toHaveText(before);

    // Footer count follows the server re-render while the sheet stays open.
    const show = sheet.getByRole("button", { name: /^show \d+ tools?$/ });
    await expect(show).not.toHaveText(showAll);

    // After closing (Radix hides the page while open), the trigger shows the filter count.
    await show.click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "filters (1)", exact: true })).toBeVisible();
  });
});
