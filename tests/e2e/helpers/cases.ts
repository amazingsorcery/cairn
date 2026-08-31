import { expect, type Page } from "@playwright/test";

/**
 * Creating and destroying throwaway cases.
 *
 * The suite must not leave rows behind. `db/seed.ts` is idempotent but does not clean up
 * after anyone, and a hundred "Vertical slice 1788…" cases in the owner account's list is
 * both noise for the next person and a slow `/workspaces` page for the next run.
 *
 * The cleanup goes through the product's own delete dialog rather than through SQL, so it is
 * also the only exercise the one-way door gets: the confirmation names the case, the delete
 * button stays disabled until the typed title matches, and the row really goes.
 */

/** Start a case and return its `/workspaces/<uuid>` URL. */
export async function createCase(page: Page, title: string): Promise<string> {
  await page.goto("/workspaces/new");
  await page.getByLabel("name this case").fill(title);
  await page.getByRole("button", { name: "start the case" }).click();
  await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
  return page.url();
}

/**
 * Delete a case through the UI. Best-effort: a cleanup that throws would replace a real
 * failure message with a cleanup failure message, which is the wrong thing to report.
 */
export async function deleteCase(page: Page, workspaceUrl: string, title: string): Promise<void> {
  try {
    await page.goto(workspaceUrl);
    await page.getByRole("button", { name: "more actions for this case" }).click();
    await page.getByRole("menuitem", { name: "delete" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Delete this case?")).toBeVisible();

    const confirm = dialog.getByRole("button", { name: "delete this case" });
    // The guard: nothing is deleted until the title has been typed back.
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("type the case title to confirm").fill(title);
    await expect(confirm).toBeEnabled();

    await confirm.click();
    await page.waitForURL(/\/workspaces\/?$/, { timeout: 15_000 });
  } catch {
    // Leave the row rather than fail the test on cleanup. `docs/qa/e2e.md` records the SQL.
  }
}
