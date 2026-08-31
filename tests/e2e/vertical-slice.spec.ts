import { expect, test } from "@playwright/test";

import { createCase, deleteCase } from "./helpers/cases";
import { signIn } from "./helpers/session";

/**
 * THE VERTICAL SLICE: discover in `/directory` → filter → open a tool → save it to a
 * collection → see it in a workspace.
 *
 * That path is the product (product-brief §2). Everything else in this suite guards a
 * property of one pillar; this file is the only one that asserts the four pillars are joined
 * up, which is the failure mode no per-route test can see.
 *
 * **It does not currently complete.** The last two steps have no user interface: nothing in
 * `app/` or `components/` calls `addWorkspaceItem`, the Server Action that would save a
 * catalogue entry into a case. `docs/frontend/HANDOFF-directory.md` §7.4 records the gap from
 * one side ("No 'save to a collection' button on `/tools/[slug]`, which
 * `wireframes/03-tool-detail` draws … whoever owns workspaces should add it there") and
 * `components/workspaces/saved-tools.tsx` records it from the other, in an empty state that
 * tells the reader to "Save one from any directory entry" — a control that does not exist.
 *
 * The failing test below is left failing on purpose. It is the finding.
 */

const TOOL_QUERY = "shodan";
const TOOL_NAME = "Shodan";
const TOOL_SLUG = "shodan";

test.describe("the vertical slice", () => {
  /**
   * DEFECT THIS CATCHES: the discovery path breaking anywhere along its length — a filter
   * that does not narrow, a card that does not link, a detail page that renders without the
   * two signals that make it citable. Each of those has its own unit and route test; only
   * this one notices when they stop composing.
   */
  test("discover → filter → open a tool", async ({ page }) => {
    // DISCOVER.
    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();
    const unfiltered = await page.getByText(/^\d+ tools · sorted by/).innerText();

    // FILTER. The name field, because it is the one filter control present in both the
    // 375px and the 1280px layouts, so the slice is exercised at both widths.
    await page.getByLabel("filter by name").fill(TOOL_QUERY);
    await page.getByLabel("filter by name").press("Enter");

    await expect(page).toHaveURL(new RegExp(`[?&]q=${TOOL_QUERY}(&|$)`));
    await expect(page.getByText(/^\d+ tools? · sorted by/)).not.toHaveText(unfiltered);
    await expect(page.getByRole("link", { name: /name: shodan — remove this filter/i })).toBeVisible();

    // OPEN A TOOL.
    await page.getByRole("link", { name: TOOL_NAME, exact: true }).first().click();
    await page.waitForURL(`**/tools/${TOOL_SLUG}`);

    await expect(page.getByRole("heading", { level: 1, name: TOOL_NAME })).toBeVisible();
    // Above the fold and never behind a tooltip — architecture HANDOFF §9.1, brand §7.3.
    await expect(
      page.getByRole("link", { name: /Our confidence in this entry:/ }).first(),
    ).toBeVisible();
    await expect(page.getByText(/Last verified /).first()).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES — and currently *does* catch: the missing half of the vertical slice.
   *
   * `lib/actions/workspaces.ts` exports `addWorkspaceItem` and `lib/validation/workspaces.ts`
   * validates its input, but no component calls either. A reader who has found the right tool
   * cannot put it in their case, and the workspace's own empty state instructs them to do
   * something the product does not let them do. Directory and Workspaces are both complete
   * against their own handoffs and the product still does not join up — which is exactly what
   * a per-pillar test suite cannot tell you.
   *
   * This test is expected to FAIL until a save control ships. Do not weaken it; the assertion
   * is the requirement.
   */
  test("save a tool to a case, and see it there", async ({ browser, baseURL }) => {
    test.slow();
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const page = await context.newPage();

    // A case to save into.
    const caseTitle = `Vertical slice ${Date.now()}`;
    const workspaceUrl = await createCase(page, caseTitle);

    try {
      // SAVE IT TO A COLLECTION. Matched by role and by what the control must say, not by a
      // test id, so any reasonable implementation satisfies it.
      await page.goto(`/tools/${TOOL_SLUG}`);
      const save = page.getByRole("button", { name: /save .*(case|collection)/i });
      await expect(
        save,
        "no control on /tools/[slug] saves an entry into a case — the vertical slice stops here",
      ).toBeVisible();

      await save.click();
      await page.getByRole("button", { name: new RegExp(caseTitle, "i") }).click();

      // SEE IT IN A WORKSPACE, with the two credibility signals travelling with it: a case
      // opened in three months has to carry them or it is a list of names (HANDOFF §9.1).
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

  /**
   * DEFECT THIS CATCHES: the workspace side of the slice regressing while the missing save
   * control hides it. A new case must derive its regions and offer a route back to the
   * catalogue — and the empty state's own sentence ("Save one from any directory entry") is
   * asserted here so that when the save control does ship, the promise and the control are
   * checked against each other rather than drifting.
   */
  test("a new case is ready to receive a saved tool", async ({ browser, baseURL }) => {
    test.slow();
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const page = await context.newPage();

    await page.goto("/workspaces/new");
    await page.getByLabel("name this case").fill(`Slice readiness ${Date.now()}`);
    await page.getByRole("button", { name: "start the case" }).click();
    await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);

    const savedTools = page.getByRole("region", { name: /saved tools/i });
    await expect(savedTools).toBeVisible();
    await expect(savedTools.getByText(/No tools saved here\. Save one from any directory entry\./))
      .toBeVisible();
    await expect(savedTools.getByRole("link", { name: /browse the directory/i })).toBeVisible();

    // Nothing about a case is written to browser storage — `states.md` §7.4. A case note on a
    // shared machine is a threat-model failure for this audience, and this is the assertion
    // that stops "offline drafts" arriving as a convenience commit.
    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored.local.filter((key) => key !== "theme")).toEqual([]);
    expect(stored.session).toEqual([]);

    await context.close();
  });
});
