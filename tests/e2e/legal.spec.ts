import { expect, test } from "@playwright/test";

/**
 * `/legal/*` pre-launch state. Unknown legal facts in `config/brand.ts` are `null`; guard
 * against both raw `{{TOKEN}}`s and invented values.
 */

const LEGAL_ROUTES = ["/legal/terms", "/legal/privacy", "/legal/acceptable-use", "/legal/disclaimer"];

test.describe("legal pages", () => {
  for (const route of LEGAL_ROUTES) {
    /**
     * `substituteBrandTokens` throws on unknown tokens, but a stray `{{...}}` the regex skips
     * (e.g. in a code fence) would still render.
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

    /** The draft banner stays while `brand.legal.reviewComplete` is false. */
    test(`${route} carries the pre-launch draft banner`, async ({ page }) => {
      await page.goto(route);

      await expect(page.getByText("Draft. No lawyer has read this.")).toBeVisible();
      await expect(
        page.getByText(/Read it as a statement of intent\. Do not rely on it as a binding agreement/),
      ).toBeVisible();

      // A draft policy is not something a crawler should surface as settled law.
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).not.toHaveCount(0);
    });
  }

  test("unestablished facts render as a visible marker, not as invented values", async ({
    page,
  }) => {
    await page.goto("/legal/privacy");
    const markers = page.getByText("[to be confirmed before launch]");
    expect(await markers.count(), "the privacy notice has unresolved facts today").toBeGreaterThan(
      0,
    );
  });

  /** `remark-gfm` autolinks bare addresses; none may render as `mailto:` links here. */
  test("no contact address on the unregistered domain renders as a link", async ({ page }) => {
    await page.goto("/legal/privacy");
    const mailtos = await page.locator('main a[href^="mailto:"]').count();
    expect(mailtos, "brand.domainRegistered is false, so nothing may be linked").toBe(0);
  });
});
