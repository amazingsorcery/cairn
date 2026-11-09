import { expect, test } from "@playwright/test";

import { mainHeadings } from "./helpers/dom";

/**
 * Credibility signals: every view of an entry shows its confidence and last-verified date,
 * linked to their definitions.
 */

/** The one seeded `needsReview` entry, which is also one of the two `http://` entries. */
const NEEDS_REVIEW_TOOL = "memento-time-travel";

test.describe("credibility signals", () => {
  test("every directory card carries a confidence chip and a last-verified date", async ({
    page,
  }) => {
    await page.goto("/directory");

    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) });
    // `count()` doesn't auto-wait.
    await expect(cards.first()).toBeVisible();
    const cardCount = await cards.count();
    expect(cardCount, "the seeded catalogue has entries on the first page").toBeGreaterThan(0);

    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index);
      await expect(
        card.getByRole("link", { name: /Our confidence in this entry:/ }),
        "confidence chip on every card",
      ).toHaveCount(1);
      await expect(card.getByText(/Last verified /), "last-verified line on every card").toHaveCount(
        1,
      );
      // Absolute date and relative age.
      await expect(card.locator("time[datetime]")).toHaveCount(1);
    }
  });

  /**
   * Also catches spelling drift between stored `needsReview`, fragment `needs-review` and
   * label "Needs review".
   */
  test("the confidence chip links to its definition on /methodology", async ({ page }) => {
    await page.goto(`/tools/${NEEDS_REVIEW_TOOL}`);

    const chip = page.getByRole("link", { name: /Our confidence in this entry: Needs review/ });
    await expect(chip.first()).toBeVisible();
    expect(await chip.first().getAttribute("href")).toBe("/methodology#needs-review");

    await chip.first().click();
    await expect(page).toHaveURL(/\/methodology#needs-review$/);
    await expect(page.locator("#needs-review")).toBeVisible();
  });

  /**
   * `needsReview` is the quietest colour on the ramp, so a dashed border and notice text
   * carry the signal (colour is never the only channel).
   */
  test("a needsReview entry is distinct in text as well as colour", async ({ page }) => {
    await page.goto(`/tools/${NEEDS_REVIEW_TOOL}`);

    await expect(page.getByText("Confidence: needs review", { exact: true })).toBeVisible();
    await expect(
      page.getByText(/that is a statement about our record, not about the tool/i),
    ).toBeVisible();

    // The structural signal: the only dashed chip in the ramp.
    const chip = page.getByRole("link", { name: /Our confidence in this entry: Needs review/ }).first();
    await expect(chip.locator("span").first()).toHaveClass(/border-dashed/);

    // This entry is also http-only; the transport warning is a separate signal.
    await expect(page.getByText(/plain http/i).first()).toBeVisible();
  });

  /**
   * Legal notes (GDPR Art. 9, EU AI Act, BIPA, CUBI) must come before the description.
   * Checked by heading order so it holds at every width.
   */
  test("/tools/pimeyes renders its legal notes above the description", async ({ page }) => {
    await page.goto("/tools/pimeyes");

    const headings = await mainHeadings(page);
    const legal = headings.findIndex((h) => /legal notes/i.test(h));
    const description = headings.findIndex((h) => /^description$/i.test(h));

    expect(legal, "the legal notes section must exist on this entry").toBeGreaterThan(-1);
    expect(description).toBeGreaterThan(-1);
    expect(legal, "legal notes come before the description").toBeLessThan(description);

    // Closing disclaimer.
    await expect(
      page.getByText(
        /Listing an entry is not endorsing it\. We name what is engaged; we cannot tell you what your legal basis is\./,
      ),
    ).toBeVisible();

    // A section, not role="alert".
    const legalSection = page.locator("section[aria-labelledby='legal-heading']");
    await expect(legalSection).toHaveCount(1);
    expect(await legalSection.getAttribute("role")).toBeNull();
  });

  /** Reliability is editorial, not a user rating (reviews aren't exposed). */
  test("reliability renders as an editorial rating, not a user rating", async ({ page }) => {
    await page.goto("/tools/shodan");

    await expect(page.getByText(/\d\/5/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /editorial rating/i }).first()).toBeVisible();
    await expect(page.getByText(/\b\d+ reviews?\b/i)).toHaveCount(0);
  });
});
