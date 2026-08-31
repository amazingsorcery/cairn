import { expect, test } from "@playwright/test";

import { mainHeadings } from "./helpers/dom";

/**
 * Credibility rendering — architecture HANDOFF §9, ADR 0007.
 *
 * These are not polish. Product-brief §6: "accuracy is the product", and §9.1 admits **no
 * view of a catalogue entry that omits its confidence and its last-verified date**. An entry
 * rendered without them is a claim the reader cannot check, which is the one thing this
 * catalogue may not do — so the assertions below are about the *presence and the linkage* of
 * those two signals, in every place an entry appears.
 */

/** The one seeded `needsReview` entry, which is also one of the two `http://` entries. */
const NEEDS_REVIEW_TOOL = "memento-time-travel";

test.describe("credibility signals", () => {
  /**
   * DEFECT THIS CATCHES: a card losing its chip or its verification line — most plausibly to
   * "tighten up" a dense grid. Every card would still render, still link, and still look
   * fine, and the catalogue would have quietly become a list of tool names.
   */
  test("every directory card carries a confidence chip and a last-verified date", async ({
    page,
  }) => {
    await page.goto("/directory");

    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 3 }) });
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
      // Absolute date AND relative age, both — HANDOFF §9.1. They answer different questions:
      // the date is what a reader cites, the age is whether to trust it.
      await expect(card.locator("time[datetime]")).toHaveCount(1);
    }
  });

  /**
   * DEFECT THIS CATCHES: a chip that states a level with no route to what the level means.
   * The chip is the most-repeated coloured element in the product; without the link it is an
   * unfalsifiable claim, and `/methodology` — a required v1 route (HANDOFF §9.4) — becomes
   * unreachable from the thing it defines. Also catches the three-way spelling drift the
   * anchor map exists to prevent: stored `needsReview`, fragment `needs-review`, label
   * "Needs review".
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
   * DEFECT THIS CATCHES: `needsReview` degrading into "just another chip". `states.md` §3.3
   * and ADR 0007 require it to be distinct **both** visually and textually — the chip is the
   * chromatically quietest step on the ramp on purpose, so the dashed border and the notice
   * carry the signal instead. Colour is never the only channel (`brand/HANDOFF.md` §3), so a
   * reader in greyscale, or one who cannot see colour at all, still gets the claim.
   *
   * It also checks the sentence that keeps the claim honest: this is a statement about *our
   * record*, not about the tool.
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

    // The three orthogonal signals are never collapsed (`states.md` §3.4). This entry is also
    // http://-only, and the transport warning is a different claim in a different region.
    await expect(page.getByText(/plain http/i).first()).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: `legalNotes` sliding below the description — which is what happens
   * the first time someone reorders the page for "reading flow". For PimEyes the notice is
   * the most important content on the page (GDPR Art. 9, the EU AI Act, BIPA, CUBI), and
   * product-brief §3.2 permits cataloguing such a tool *only* because the risk is stated:
   * "a directory that hides the risk is worse than one that omits the entry".
   *
   * Asserted on document order of the section headings rather than on pixel positions, so it
   * holds at 375px and at 1280px, where the page has two different shapes.
   */
  test("/tools/pimeyes renders its legal notes above the description", async ({ page }) => {
    await page.goto("/tools/pimeyes");

    const headings = await mainHeadings(page);
    const legal = headings.findIndex((h) => /legal notes/i.test(h));
    const description = headings.findIndex((h) => /^description$/i.test(h));

    expect(legal, "the legal notes section must exist on this entry").toBeGreaterThan(-1);
    expect(description).toBeGreaterThan(-1);
    expect(legal, "legal notes come before the description").toBeLessThan(description);

    // The closing line that makes it a naming of instruments, not advice or permission.
    await expect(
      page.getByText(
        /Listing an entry is not endorsing it\. We name what is engaged; we cannot tell you what your legal basis is\./,
      ),
    ).toBeVisible();

    // Not the Alert primitive: a page's most substantial body copy is not a `role="alert"`.
    const legalSection = page.locator("section[aria-labelledby='legal-heading']");
    await expect(legalSection).toHaveCount(1);
    expect(await legalSection.getAttribute("role")).toBeNull();
  });

  /**
   * DEFECT THIS CATCHES: the editorial 1–5 reliability being rendered as a user rating —
   * stars, an average, a review count. ADR 0010 does not ship `reviews`, and a five-star
   * treatment would invent a crowd that does not exist on a page whose whole value is that
   * every claim is attributable.
   */
  test("reliability renders as an editorial rating, not a user rating", async ({ page }) => {
    await page.goto("/tools/shodan");

    await expect(page.getByText(/\d\/5/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /editorial rating/i }).first()).toBeVisible();
    await expect(page.getByText(/\b\d+ reviews?\b/i)).toHaveCount(0);
  });
});
