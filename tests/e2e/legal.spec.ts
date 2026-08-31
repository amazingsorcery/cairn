import { expect, test } from "@playwright/test";

/**
 * `/legal/*` — the pre-launch state.
 *
 * `config/brand.ts` has `legal.reviewComplete: false`, and `governingLaw`, `dataRegion`,
 * `policyEffectiveDate` and `currency` are all `null` **on purpose**: "a privacy policy that
 * names a governing law we invented is worse than one that admits the gap — it is a false
 * statement of fact in the one document a user is entitled to rely on".
 *
 * So there are two failure modes to guard, and they pull in opposite directions: shipping a
 * raw `{{TOKEN}}`, and shipping a plausible invented value in its place.
 */

const LEGAL_ROUTES = ["/legal/terms", "/legal/privacy", "/legal/acceptable-use", "/legal/disclaimer"];

test.describe("legal pages", () => {
  for (const route of LEGAL_ROUTES) {
    /**
     * DEFECT THIS CATCHES: an unresolved placeholder reaching a reader. `substituteBrandTokens`
     * throws on an *unknown* token, which covers a typo — but a token that is known and maps
     * to an empty string, or a document authored with a stray `{{...}}` in a code fence that
     * the regex skips, would render as-is. Raw template syntax in a policy is the placeholder
     * slop product-brief §7 forbids, and it appears in the one document meant to be relied on.
     */
    test(`${route} renders no unresolved {{TOKEN}}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const text = await page.locator("main").innerText();
      const tokens = text.match(/\{\{[^}]{0,80}\}\}/g) ?? [];
      expect(tokens, `unresolved placeholders on ${route}`).toEqual([]);

      // And no brand string was typed by hand rather than substituted.
      expect(text).not.toContain("BRAND_");
    });

    /**
     * DEFECT THIS CATCHES: the draft banner disappearing while `brand.legal.reviewComplete`
     * is still `false` — which would present an unreviewed policy as settled law. It is a
     * one-line change (`{document.isDraft ? … : null}`) and nothing else in the build would
     * notice. `HANDOFF-shell.md` §12.4 records that these pages are linked from the footer
     * *because* the draft state is made loud; remove the banner and that trade collapses.
     */
    test(`${route} carries the pre-launch draft banner`, async ({ page }) => {
      await page.goto(route);

      await expect(page.getByText("Draft. No lawyer has read this.")).toBeVisible();
      await expect(
        page.getByText(/Read it as a statement of intent\. Do not rely on it as a binding agreement/),
      ).toBeVisible();

      // A draft policy is not something a crawler should surface as settled law.
      expect(await page.locator('meta[name="robots"][content*="noindex"]').count()).toBeGreaterThan(0);
    });
  }

  /**
   * DEFECT THIS CATCHES: an unestablished fact being filled in with a plausible value. The
   * marker is deliberately conspicuous; a "tidy-up" that replaced it with, say, "England and
   * Wales" would read perfectly and be a fabricated legal claim.
   */
  test("unestablished facts render as a visible marker, not as invented values", async ({
    page,
  }) => {
    await page.goto("/legal/privacy");
    const markers = page.getByText("[to be confirmed before launch]");
    expect(await markers.count(), "the privacy notice has unresolved facts today").toBeGreaterThan(
      0,
    );
  });

  /**
   * DEFECT THIS CATCHES: a contact address becoming a live `mailto:` while
   * `brand.domainRegistered` is `false`. `remark-gfm`'s autolink literals turn a bare address
   * into a link with no markup asking for one, and the domain is an RFC 2606 `.example` that
   * can never resolve — so the link would be dead today and, the day a real domain is bought,
   * could point at a mailbox belonging to somebody else.
   */
  test("no contact address on the unregistered domain renders as a link", async ({ page }) => {
    await page.goto("/legal/privacy");
    const mailtos = await page.locator('main a[href^="mailto:"]').count();
    expect(mailtos, "brand.domainRegistered is false, so nothing may be linked").toBe(0);
  });
});
