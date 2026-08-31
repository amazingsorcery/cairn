import { expect, test } from "@playwright/test";

import { settled } from "./helpers/dom";

/**
 * `/directory` — the filter contract.
 *
 * `docs/frontend/HANDOFF-directory.md` §2 states the property this file exists to protect:
 * **all filter state is in the URL and there is no component state.** That is what makes a
 * filtered view pasteable into a note and what makes the browser's own back button work.
 * A refactor to `useState` would look tidier, pass every unit test, and quietly break both.
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

  /**
   * DEFECT THIS CATCHES: filter state moving into React state. The symptom would be a URL
   * that no longer describes the view — so a shared link opens the unfiltered catalogue and
   * the reader you sent it to sees something different from what you saw. `states.md` §2.1
   * depends on the URL being the source of truth ("getting back is never more than one
   * click, and the browser back button also works").
   */
  test("ticking a facet writes it to the URL, and back/forward restore the checkbox", async ({
    page,
  }) => {
    await page.goto("/directory");
    // The facet inputs mirror the URL through React state; ticking one before hydration is
    // overwritten by the first client render. See the note in vertical-slice.spec.ts.
    await settled(page);

    const free = sidebar(page).getByRole("checkbox", { name: "free", exact: true });
    await expect(free).not.toBeChecked();

    const unfilteredCount = await page.getByText(/^\d+ tools · sorted by/).innerText();

    await free.check();
    await expect(page).toHaveURL(/[?&]cost=free(&|$)/);
    await expect(free).toBeChecked();

    const filteredCount = await page.getByText(/^\d+ tools · sorted by/).innerText();
    expect(filteredCount).not.toBe(unfilteredCount);

    // BACK. The checkbox must re-sync from the URL, not keep its own memory of being ticked.
    await page.goBack();
    await expect(page).toHaveURL(/\/directory$/);
    await expect(free).not.toBeChecked();
    await expect(page.getByText(/^\d+ tools · sorted by/)).toHaveText(unfilteredCount);

    // FORWARD. The same, in the other direction.
    await page.goForward();
    await expect(page).toHaveURL(/[?&]cost=free(&|$)/);
    await expect(free).toBeChecked();
  });

  /**
   * DEFECT THIS CATCHES: a filtered URL that does not reproduce the view it came from —
   * because a facet is only applied by a click handler, or because the parser and the
   * serialiser disagree. `HANDOFF-directory.md` §3 records exactly this bug shipping once:
   * `confidence=needsReview` and `cost=freeWithRegistration` were silently dropped by a
   * lowercasing parser, which made the one confidence level a careful reader most needs to
   * isolate unreachable from a URL, with no error anywhere.
   */
  test("a filtered URL is shareable and reproduces its own checkbox state", async ({ page }) => {
    // Both camelCase vocabulary values, i.e. the two that were unreachable before the fix.
    await page.goto("/directory?confidence=needsReview&cost=freeWithRegistration");

    await expect(
      sidebar(page).getByRole("checkbox", { name: "needs review", exact: true }),
    ).toBeChecked();
    await expect(
      sidebar(page).getByRole("checkbox", { name: "free with registration", exact: true }),
    ).toBeChecked();

    // The removable chips are the visible proof that the URL was understood, not ignored.
    // Anchored on the chip's own screen-reader suffix, because this combination happens to
    // yield no results and the empty state offers a "remove …" button with a similar name.
    await expect(
      page.getByRole("link", { name: /^confidence: needs review — remove this filter$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^cost: free with registration — remove this filter$/i }),
    ).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: a dead-end zero-result page. `states.md` §2.1 requires the empty
   * state to name the single removal that widens the result set most and forbids guessing it
   * — and the number must be measured, because `voice.md` rule 1 forbids a claim without the
   * figure supporting it. A regression that replaced the computed removal with "try removing
   * a filter" would still render, still look fine, and be useless.
   */
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

    // The named removal actually widens the result set — the sentence was true.
    await expect(page.getByText(/^[1-9]\d* tools? · sorted by/)).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: a "clear all" that does not clear, which is the failure mode
   * `filter-url.test.ts`'s round-trip contract exists to prevent at the unit level. This is
   * the end-to-end half: the serialiser's cleared URL has to be one the parser reads back as
   * no filters at all.
   */
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

  /**
   * DEFECT THIS CATCHES: the mobile facet surface losing its footer count, or the sheet's
   * copy of the panel writing to a different URL than the sidebar's. Both panels are the
   * same Server Component rendered twice with different `idPrefix`es, and the sheet's
   * "show N tools" is live because the facets push the URL while it stays open — so a
   * regression that made the sheet hold local state would show up here as a count that never
   * moves.
   */
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

    // The sheet's own footer count follows the server re-render while the sheet stays open —
    // "show 47 tools" is the number of results currently waiting behind the sheet, not a
    // promise about a pending selection.
    const show = sheet.getByRole("button", { name: /^show \d+ tools?$/ });
    await expect(show).not.toHaveText(showAll);

    // Closing returns to the results, and the trigger now carries the active-filter count.
    // (Radix marks the rest of the page `aria-hidden` while the sheet is open, so the
    // trigger is only reachable by role once the dialog has closed.)
    await show.click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "filters (1)", exact: true })).toBeVisible();
  });
});
