import { expect, test } from "@playwright/test";

import { createCase, deleteCase } from "./helpers/cases";
import { settled } from "./helpers/dom";
import { signIn } from "./helpers/session";

/**
 * The vertical slice: discover in `/directory` → filter → open a tool → save it to a case →
 * see it in the workspace. The only test that checks the pillars join up.
 *
 * The save step has no UI yet (nothing calls `addWorkspaceItem`), so the save test is
 * expected to fail until that control ships.
 */

const TOOL_QUERY = "shodan";
const TOOL_NAME = "Shodan";
const TOOL_SLUG = "shodan";

test.describe("the vertical slice", () => {
  test("discover → filter → open a tool", async ({ page }) => {
    // Discover.
    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();
    const unfiltered = await page.getByText(/^\d+ tools · sorted by/).innerText();

    // Wait for hydration: the name field is controlled, and typing before React attaches
    // gets overwritten.
    await settled(page);

    // Filter, using the name field since it exists at both widths.
    await page.getByLabel("filter by name").fill(TOOL_QUERY);
    await page.getByLabel("filter by name").press("Enter");

    await expect(page).toHaveURL(new RegExp(`[?&]q=${TOOL_QUERY}(&|$)`));
    await expect(page.getByText(/^\d+ tools? · sorted by/)).not.toHaveText(unfiltered);
    await expect(page.getByRole("link", { name: /name: shodan — remove this filter/i })).toBeVisible();

    // Open a tool.
    await page.getByRole("link", { name: TOOL_NAME, exact: true }).first().click();
    await page.waitForURL(`**/tools/${TOOL_SLUG}`);

    await expect(page.getByRole("heading", { level: 1, name: TOOL_NAME })).toBeVisible();
    // Credibility signals are visible, not behind a tooltip.
    await expect(
      page.getByRole("link", { name: /Our confidence in this entry:/ }).first(),
    ).toBeVisible();
    await expect(page.getByText(/Last verified /).first()).toBeVisible();
  });

  /** Expected to fail until a save control ships; don't weaken it. */
  test("save a tool to a case, and see it there", async ({ browser, baseURL }) => {
    test.slow();
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const page = await context.newPage();

    // A case to save into.
    const caseTitle = `Vertical slice ${Date.now()}`;
    const workspaceUrl = await createCase(page, caseTitle);

    try {
      // Matched by role and label so any reasonable implementation passes.
      await page.goto(`/tools/${TOOL_SLUG}`);
      const save = page.getByRole("button", { name: /save .*(case|collection)/i });
      await expect(
        save,
        "no control on /tools/[slug] saves an entry into a case — the vertical slice stops here",
      ).toBeVisible();

      await save.click();
      await page.getByRole("button", { name: new RegExp(caseTitle, "i") }).click();

      // It appears in the workspace with its credibility signals.
      await page.goto(workspaceUrl);
      const savedTools = page.getByRole("region", { name: /saved tools/i });
      await expect(savedTools.getByRole("link", { name: TOOL_NAME })).toBeVisible();
      await expect(
        savedTools.getByRole("link", { name: /Our confidence in this entry:/ }),
      ).toBeVisible();
      await expect(savedTools.getByText(/Last verified /)).toBeVisible();
    } finally {
      await deleteCase(page, workspaceUrl, caseTitle);
      await context.close();
    }
  });

  /** The workspace side of the slice: empty state and a route back to the catalogue. */
  test("a new case is ready to receive a saved tool", async ({ browser, baseURL }) => {
    test.slow();
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const page = await context.newPage();

    const caseTitle = `Slice readiness ${Date.now()}`;
    const workspaceUrl = await createCase(page, caseTitle);

    try {
      const savedTools = page.getByRole("region", { name: /saved tools/i });
      await expect(savedTools).toBeVisible();
      await expect(
        savedTools.getByText(/No tools saved here\. Save one from any directory entry\./),
      ).toBeVisible();
      await expect(savedTools.getByRole("link", { name: /browse the directory/i })).toBeVisible();

      // Nothing about a case goes into browser storage (shared machines).
      const stored = await page.evaluate(() => ({
        local: Object.keys(window.localStorage),
        session: Object.keys(window.sessionStorage),
      }));
      expect(stored.local.filter((key) => key !== "theme")).toEqual([]);
      expect(stored.session).toEqual([]);
    } finally {
      await deleteCase(page, workspaceUrl, caseTitle);
      await context.close();
    }
  });
});
