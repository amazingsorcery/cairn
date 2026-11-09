import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { THEME_STORAGE_KEY } from "@/components/layout/theme";

import { settled } from "./helpers/dom";

/**
 * axe WCAG A/AA rules (contrast, ARIA, names, labels), complementing the structural checks
 * in `accessibility.spec.ts`. Runs in both themes. No rules are disabled; only the dev
 * overlay is excluded.
 */

/** `<nextjs-portal>` is the dev server's error overlay. Not our markup, not in production. */
const NOT_OURS = "nextjs-portal";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/** A spread of page shapes, including the colour-heavy `/methodology` and `/live/cameras`. */
const ROUTES = [
  "/",
  "/directory",
  "/tools/shodan",
  "/methodology",
  "/live/cameras",
  "/playbooks",
  "/legal/terms",
  "/search?q=shodan",
];

type Theme = "light" | "dark";

async function analyse(page: Page, path: string, theme: Theme) {
  // Before navigation: the theme boot script reads localStorage synchronously.
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch {
        /* private mode — the boot script's own try/catch covers this */
      }
    },
    [THEME_STORAGE_KEY, theme],
  );
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Confirm the theme actually took, so a failure is never "we tested dark twice".
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

  // Scanning mid-stream reports skeleton contrast and a missing lang/title.
  await settled(page);

  return new AxeBuilder({ page }).withTags(TAGS).exclude(NOT_OURS).analyze();
}

/** Readable failure output: axe's own `violations` array is enormous and mostly noise. */
function summarise(violations: { id: string; impact?: string | null | undefined; help: string; nodes: { target: unknown[] }[] }[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "n/a"}) — ${violation.help}\n` +
        violation.nodes
          .slice(0, 5)
          .map((node) => `      ${JSON.stringify(node.target)}`)
          .join("\n"),
    )
    .join("\n");
}

for (const theme of ["light", "dark"] as Theme[]) {
  test.describe(`axe — ${theme} theme`, () => {
    test.skip(
      ({ isMobile }) => isMobile === true,
      "the same rules on the same markup; the mobile-only surface is the nav sheet, covered separately",
    );

    for (const path of ROUTES) {
      test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
        const results = await analyse(page, path, theme);
        expect(
          results.violations,
          results.violations.length === 0
            ? ""
            : `${results.violations.length} violation(s) on ${path} in ${theme}:\n${summarise(results.violations)}`,
        ).toEqual([]);
      });
    }
  });
}

test.describe("axe — the mobile navigation sheet", () => {
  test.skip(({ isMobile }) => isMobile !== true, "the sheet only exists below md:");

  /** Mobile-only surface the desktop sweep can't see. */
  test("the open sheet has no WCAG A/AA violations", async ({ page }) => {
    await page.goto("/directory");
    await page.getByRole("button", { name: /menu/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(TAGS).exclude(NOT_OURS).analyze();
    expect(
      results.violations,
      results.violations.length === 0
        ? ""
        : `${results.violations.length} violation(s) in the mobile nav sheet:\n${summarise(results.violations)}`,
    ).toEqual([]);
  });
});
