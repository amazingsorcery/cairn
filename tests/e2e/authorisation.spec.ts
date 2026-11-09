import { expect, test } from "@playwright/test";

import { createCase, deleteCase } from "./helpers/cases";
import { expectNotFoundBody, renderedIdentity } from "./helpers/dom";
import { signIn } from "./helpers/session";

/**
 * Authorisation: the wrong person must learn nothing. A 403, or an admin page title above a
 * 404 body, would reveal that the resource exists. Denials assert both status and body.
 */

const OWNER_WORKSPACE_PATH_ENV = "E2E_OWNER_WORKSPACE_ID";

/** A reusable case owned by `owner`, used as the "exists but is not yours" target. */
const OWNER_PROBE_CASE = "Ownership boundary probe";

/**
 * Normalise streaming/timing artefacts so two responses can be compared byte-for-byte.
 * Under `next dev`, flush boundaries and suspense holder ids (`S:2`) vary with load.
 *
 *   `markup`:  the document without scripts, holder ids normalised.
 *   `payload`: the `self.__next_f.push` chunks concatenated, so cut points don't matter.
 *
 * Also normalises `?v=` cache-busters and server-timing spans, and the requested workspace id
 * (echoed into `callbackUrl`).
 */
function canonicalise(html: string, workspaceId: string): { markup: string; payload: string } {
  const normalised = html
    .replaceAll(workspaceId, "WORKSPACE_ID")
    .replace(/\?v=\d+/g, "?v=V")
    .replace(/:N-?\d+(\.\d+)?/g, ":N0")
    .replace(/\\"(start|end)\\":-?[\d.]+/g, '\\"$1\\":0')
    .replace(/\b([SB]):\d+\b/g, "$1:N");

  const payload = [...normalised.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((match) => match[1] ?? "")
    .join("");

  const markup = normalised.replace(/<script[\s\S]*?<\/script>/g, "");

  return { markup, payload };
}

/** `next dev` injects its devtools into the RSC stream; `next start` does not. */
function isDevServer(html: string): boolean {
  return html.includes("next-devtools");
}

test.describe("signed out", () => {
  /** Every protected route redirects signed-out visitors. */
  for (const path of [
    "/workspaces",
    "/workspaces/new",
    "/workspaces/00000000-0000-4000-8000-000000000000",
    "/admin",
    "/admin/queue",
    "/admin/tools",
    "/admin/playbooks",
    "/admin/cameras",
    "/admin/connectors",
    "/admin/taxonomy",
  ]) {
    test(`${path} redirects to /signin`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/signin\?callbackUrl=/);
      // Built from the request's own path, never a query value (open redirect).
      expect(decodeURIComponent(new URL(page.url()).searchParams.get("callbackUrl") ?? "")).toBe(
        path,
      );
    });
  }
});

test.describe("a signed-in non-owner", () => {
  /**
   * "Not yours" must be indistinguishable from "does not exist", or workspace ids become
   * enumerable. Compares markup and RSC payload after `canonicalise`.
   */
  test("gets a response byte-identical to a non-existent id", async ({ browser, baseURL }) => {
    // next dev compiles routes on first request.
    test.slow();

    const context = await browser.newContext({ baseURL });
    await signIn(context, "other", baseURL!);
    const page = await context.newPage();

    // A workspace owned by `owner`: reuse the probe case or create it.
    const ownerContext = await browser.newContext({ baseURL });
    await signIn(ownerContext, "owner", baseURL!);
    const ownerPage = await ownerContext.newPage();
    let targetId = process.env[OWNER_WORKSPACE_PATH_ENV] ?? null;
    if (!targetId) {
      await ownerPage.goto("/workspaces");
      // Wait for the streamed list (any case or the empty state) before counting; `count()`
      // doesn't auto-wait.
      const anyCase = ownerPage.locator('a[href^="/workspaces/"]');
      const empty = ownerPage.getByRole("heading", { name: "No cases yet" });
      await expect(anyCase.first().or(empty).first()).toBeVisible();

      const probe = ownerPage.getByRole("link", { name: OWNER_PROBE_CASE, exact: true });
      if ((await probe.count()) > 0) {
        const href = await probe.first().getAttribute("href");
        targetId = href?.match(/^\/workspaces\/([0-9a-f-]{36})$/)?.[1] ?? null;
      } else {
        // Kept rather than deleted: the next run finds it and creates nothing.
        const created = await createCase(ownerPage, OWNER_PROBE_CASE);
        targetId = new URL(created).pathname.split("/").pop() ?? null;
      }
    }
    expect(targetId, "a real workspace id is needed to make this assertion mean anything").not.toBe(
      null,
    );
    const unknownId = "00000000-0000-4000-8000-000000000000";

    const notYours = await page.request.get(`/workspaces/${targetId!}`);
    const notThere = await page.request.get(`/workspaces/${unknownId}`);

    expect(notYours.status(), "no 403 — a 403 confirms the row exists").toBe(notThere.status());
    expect(notYours.status(), "and both are a real 404").toBe(404);

    const notYoursHtml = await notYours.text();
    const notThereHtml = await notThere.text();
    const served = canonicalise(notYoursHtml, targetId!);
    const absent = canonicalise(notThereHtml, unknownId);

    expect(served.markup, "the served markup must not differ").toBe(absent.markup);

    // Payload comparison only against a production build; next dev adds instrumentation
    // whose numbering varies under load.
    if (isDevServer(notYoursHtml) || isDevServer(notThereHtml)) {
      test.info().annotations.push({
        type: "scope",
        description:
          "RSC payload comparison skipped: dev server. Run without E2E_BASE_URL (production build) for the full byte comparison.",
      });
    } else {
      expect(served.payload, "the streamed RSC payload must not differ either").toBe(absent.payload);
    }

    // And the rendered page says nothing about ownership either.
    await page.goto(`/workspaces/${targetId!}`);
    await expectNotFoundBody(page);
    const renderedNotYours = await renderedIdentity(page);
    await page.goto(`/workspaces/${unknownId}`);
    await expectNotFoundBody(page);
    const renderedAbsent = await renderedIdentity(page);
    expect(renderedNotYours).toEqual(renderedAbsent);
    expect(renderedNotYours.main).not.toMatch(/permission|forbidden|not yours|another user/i);

    await context.close();
    await ownerContext.close();
  });

  /** The export handler checks ownership itself, before producing any bytes. */
  test("cannot export another account's case", async ({ browser, baseURL }) => {
    test.slow();
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const ownerPage = await context.newPage();
    const caseTitle = `Export boundary probe ${Date.now()}`;
    const workspaceUrl = await createCase(ownerPage, caseTitle);
    const id = new URL(workspaceUrl).pathname.split("/").pop()!;

    const otherContext = await browser.newContext({ baseURL });
    try {
      const ownExport = await ownerPage.request.get(`/workspaces/${id}/export?format=md`);
      expect(ownExport.status()).toBe(200);
      expect(await ownExport.text()).toContain(caseTitle);

      await signIn(otherContext, "other", baseURL!);
      const otherPage = await otherContext.newPage();
      const stolen = await otherPage.request.get(`/workspaces/${id}/export?format=md`);
      expect(stolen.status()).not.toBe(200);
      expect(await stolen.text()).not.toContain(caseTitle);
    } finally {
      await deleteCase(ownerPage, workspaceUrl, caseTitle);
      await context.close();
      await otherContext.close();
    }
  });
});

test.describe("a plain user under /admin", () => {
  /**
   * Next resolves metadata even when the page calls `notFound()`, so a static admin title
   * would leak. `adminMetadata()` gates it on the role.
   */
  for (const path of ["/admin", "/admin/queue", "/admin/connectors", "/admin/taxonomy"]) {
    test(`${path} is not found, and its title leaks nothing`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL });
      await signIn(context, "owner", baseURL!); // role `user`
      const page = await context.newPage();

      const response = await page.goto(path);
      expect(response?.status(), "a role denial is a 404, never a 403").toBe(404);
      await expectNotFoundBody(page);

      const title = await page.title();
      expect(title, "the title must not name the admin page").toMatch(/^Not found/);
      for (const leak of ["Connectors", "Taxonomy", "Queue", "Admin", "Editorial"]) {
        expect(title).not.toContain(leak);
      }

      await context.close();
    });
  }

  /**
   * Connectors and taxonomy are admin-only; checked per page, not just in the admin layout.
   */
  test("an editor reaches the queue but not the connectors", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, "editor", baseURL!);
    const page = await context.newPage();

    await page.goto("/admin/queue");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/not found/i);

    const denied = await page.goto("/admin/connectors");
    expect(denied?.status(), "an editor is refused connectors with a 404, not a 403").toBe(404);
    await expectNotFoundBody(page);
    expect(await page.title()).toMatch(/^Not found/);

    await context.close();
  });
});
