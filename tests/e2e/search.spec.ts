import { expect, test } from "@playwright/test";

/**
 * `/search`. `didYouMean` (pg_trgm similarity) is only populated when both ranked groups are
 * empty. It's on a different scale from `ts_rank_cd`, so it renders as its own group and the
 * page says how it was found.
 */

test.describe("search", () => {
  /**
   * The fallback must stay separate from ranked results and keep its explanation.
   * `similarity('Shodan', 'shodun') = 0.4`, so this works against the real seed.
   */
  test("a misspelling triggers the trigram fallback and the page says so", async ({ page }) => {
    await page.goto("/search?q=shodun");

    await expect(page.getByText(/No exact matches for “shodun”/)).toBeVisible();
    await expect(
      page.getByText(
        /found by spelling, not by meaning, so read them as suggestions rather than as results/i,
      ),
    ).toBeVisible();

    // The suggestion is offered, not applied: the field still holds what was typed.
    await expect(page.getByRole("combobox")).toHaveValue("shodun");
    await expect(page.getByRole("link", { name: /Shodan/ }).first()).toBeVisible();

    // Not mixed into a ranked group.
    await expect(page.getByRole("heading", { name: /^tools \(\d+\)$/ })).toHaveCount(0);

    // The screen-reader announcement carries the same caveat as the visible alert.
    await expect(
      page.getByText(/No exact matches for shodun\. Showing \d+ entr(y|ies) with similar names\./),
    ).toBeAttached();
  });

  /** No results keeps the query for editing and isn't rendered as an error. */
  test("nothing matched keeps the query and offers a way onward", async ({ page }) => {
    await page.goto("/search?q=zzzqqqxxwv");

    await expect(page.getByRole("heading", { name: /Nothing matches “zzzqqqxxwv”/ })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveValue("zzzqqqxxwv");
    await expect(page.getByRole("link", { name: /browse the directory/i })).toBeVisible();

    // Checked by copy: Next's route announcer is always a role="alert".
    await expect(page.getByText(/Couldn’t run that search/)).toHaveCount(0);
  });

  /** An empty query shows categories, not an error. */
  test("an empty query is not an error", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /browse by category/i })).toBeVisible();
    await expect(page.getByText(/Couldn’t run that search/)).toHaveCount(0);
    await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
  });
});
