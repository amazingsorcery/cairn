import { expect, type Page } from "@playwright/test";

/**
 * Creating and deleting throwaway cases. Cleanup uses the real delete dialog, which also
 * exercises its type-the-title confirmation.
 */

/** Start a case and return its `/workspaces/<uuid>` URL. */
export async function createCase(page: Page, title: string): Promise<string> {
  await page.goto("/workspaces/new");
  await page.getByLabel("name this case").fill(title);
  await page.getByRole("button", { name: "start the case" }).click();
  await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
  return page.url();
}

/** Delete a case through the UI. Best-effort, so it never masks the real failure. */
export async function deleteCase(page: Page, workspaceUrl: string, title: string): Promise<void> {
  // Short timeouts: this runs in `finally` and shouldn't turn a failure into a timeout.
  const t = { timeout: 8_000 };
  try {
    await page.goto(workspaceUrl, { timeout: 15_000 });
    await page.getByRole("button", { name: "more actions for this case" }).click(t);
    await page.getByRole("menuitem", { name: "delete" }).click(t);

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Delete this case?")).toBeVisible(t);

    const confirm = dialog.getByRole("button", { name: "delete this case" });
    // The guard: nothing is deleted until the title has been typed back.
    await expect(confirm).toBeDisabled(t);
    await dialog.getByLabel("type the case title to confirm").fill(title, t);
    await expect(confirm).toBeEnabled(t);

    await confirm.click(t);
    await page.waitForURL(/\/workspaces\/?$/, { timeout: 15_000 });
  } catch {
    // Leave the row rather than fail the test on cleanup.
  }
}
