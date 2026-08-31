import { expect, test } from "@playwright/test";

/**
 * `/search` — and the one sentence on it that is a product requirement rather than a nicety.
 *
 * `search()` populates `didYouMean` only when both ranked groups came back empty. Those hits
 * are a `pg_trgm` similarity match on the name, on a completely different scale from
 * `ts_rank_cd`, and `docs/architecture/search.md` §5 forbids merging the two. The page
 * therefore renders them as their own labelled group and **says what it did**.
 */

test.describe("search", () => {
  /**
   * DEFECT THIS CATCHES: the trigram fallback being merged into the ranked results, or its
   * explanation being dropped as clutter. Both are silent: the page still renders, still
   * lists Shodan, and still looks correct. The harm is epistemic — a reader who searches a
   * misspelling and sees a bare list concludes we silently corrected them; a reader who sees
   * nothing concludes the tool is not in the catalogue. Neither is true, and for an audience
   * that publishes on the strength of what this page says, "found by spelling, not by
   * meaning" is the difference between a suggestion and a result.
   *
   * `similarity('Shodan', 'shodun') = 0.4` (integration finding I-10), so this path is
   * reachable against the real seed and does not depend on the planner's choices.
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

    // It is a separate group, never mixed into a ranked one — a rank scale and a similarity
    // scale in the same list is a claim about ordering that nothing supports.
    await expect(page.getByRole("heading", { name: /^tools \(\d+\)$/ })).toHaveCount(0);

    // The screen-reader announcement carries the same caveat as the visible alert.
    await expect(
      page.getByText(/No exact matches for shodun\. Showing \d+ entr(y|ies) with similar names\./),
    ).toBeAttached();
  });

  /**
   * DEFECT THIS CATCHES: a nothing-matched state that clears the field, forcing the reader to
   * retype a query they were about to edit — `states.md` §8.2 keeps the query precisely so it
   * can be edited. Also catches the state being rendered as an error: an empty result is not
   * a failure and must not carry error styling or a retry.
   */
  test("nothing matched keeps the query and offers a way onward", async ({ page }) => {
    await page.goto("/search?q=zzzqqqxxwv");

    await expect(page.getByRole("heading", { name: /Nothing matches “zzzqqqxxwv”/ })).toBeVisible();
    await expect(page.getByRole("combobox")).toHaveValue("zzzqqqxxwv");
    await expect(page.getByRole("link", { name: /browse the directory/i })).toBeVisible();

    // Not rendered as a failure. Asserted on the copy rather than on the absence of
    // `role="alert"`: Next injects its own `role="alert"` route announcer into every page,
    // so an alert count of zero is never achievable and would be a test that cannot pass.
    await expect(page.getByText(/Couldn’t run that search/)).toHaveCount(0);
  });

  /**
   * DEFECT THIS CATCHES: an empty query being treated as a mistake. `states.md` §8.5 — the
   * page offers the categories and no scolding. A regression to "enter a search term" copy
   * would be the kind of thing nobody reports and everybody notices.
   */
  test("an empty query is not an error", async ({ page }) => {
    await page.goto("/search");

    await expect(page.getByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /browse by category/i })).toBeVisible();
    await expect(page.getByText(/Couldn’t run that search/)).toHaveCount(0);
    await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
  });
});
