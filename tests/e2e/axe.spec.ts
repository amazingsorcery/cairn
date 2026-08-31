import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { THEME_STORAGE_KEY } from "@/components/layout/theme";

import { settled } from "./helpers/dom";

/**
 * Automated accessibility rules — the coverage `accessibility.spec.ts` cannot reach.
 *
 * That file checks structure and keyboard operability: one `h1`, a skip link, a visible focus
 * ring at every stop, no trap. Those are the things a human notices and a machine cannot.
 * This file is the other half: colour contrast, ARIA validity, name/role/value, form
 * labelling — the things a machine notices reliably and a human misses.
 *
 * **BOTH THEMES, DELIBERATELY.** `docs/qa/accessibility.md` records that light-theme and
 * non-text contrast were never tested at all, and the product resolves its theme
 * stored choice → `prefers-color-scheme` → dark (ADR 0016 §4). A palette that passes in dark
 * and fails in light is a palette that fails for whoever opens the site on a bright screen,
 * and nothing else in this build would catch it.
 *
 * WHAT IS NOT DISABLED. No rule is turned off to make this pass. If axe finds something, the
 * test fails and the finding is reported — a suppressed rule is a defect with a comment
 * attached to it. The only scoping is `exclude`, and there is exactly one, for the dev
 * server's own injected overlay, which is not ours and is not shipped.
 */

/** `<nextjs-portal>` is the dev server's error overlay. Not our markup, not in production. */
const NOT_OURS = "nextjs-portal";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * A spread of page shapes rather than every route: a dense card grid, a long prose document,
 * a form-heavy filter surface, a data table, and the two pages whose whole job is colour
 * (`/methodology` renders all four confidence chips; `/live/cameras` renders badges and
 * status colour).
 */
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
  // Set before navigation: the theme boot script reads `localStorage` synchronously as the
  // first child of `<body>`, so a value written afterwards would only apply on the next load.
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

  /*
   * Analyse a settled page. Scanning mid-stream produces confident nonsense — a skeleton
   * whose placeholder blocks "fail" contrast 44 times, and a document that has not received
   * its `<html lang>` or `<title>` yet reported as missing both. Those are findings about
   * the scan's timing, not about the product, and shipping them would train people to ignore
   * the ones that are real.
   */
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
      /**
       * DEFECT THIS CATCHES: a contrast ratio below 4.5:1 introduced by a token change, an
       * `aria-*` attribute that names nothing, a control with no accessible name, a form
       * field with no label. Every one of those renders perfectly and is invisible to a
       * reviewer reading the diff.
       */
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

  /**
   * DEFECT THIS CATCHES: the one surface that exists only at 375px, and therefore the one the
   * desktop sweep above can never see. A modal with an invalid ARIA state or an unnamed close
   * control is exactly the kind of thing that ships when only one width is audited.
   */
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
