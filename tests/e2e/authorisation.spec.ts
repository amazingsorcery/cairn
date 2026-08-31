import { expect, test } from "@playwright/test";

import { expectNotFoundBody, renderedIdentity } from "./helpers/dom";
import { signIn } from "./helpers/session";

/**
 * Authorisation — architecture HANDOFF §11 assertions 1 and 2, `sitemap.md` §8, ADR 0008.
 *
 * The property under test is not "the wrong person is stopped". It is **the wrong person
 * learns nothing**. For this audience a case file's *existence* is sensitive: a 403 says "that
 * workspace is real and belongs to someone else", which is an enumeration oracle, and a
 * `<title>Connectors · Cairn</title>` above a 404 body discloses exactly what the 404 was for.
 *
 * On the status code, see `expectNotFoundBody` and integration finding **I-15**: `notFound()`
 * returns HTTP 200 in this Next version, so these specs assert the body and the `noindex` tag
 * instead.
 */

const OWNER_WORKSPACE_PATH_ENV = "E2E_OWNER_WORKSPACE_ID";

test.describe("signed out", () => {
  /**
   * DEFECT THIS CATCHES: a new route under `/workspaces` or `/admin` that forgets its guard.
   * `sitemap.md` §10.2 calls for exactly this check, path by path, because the guard lives in
   * two places (`middleware.ts` and the per-route session/role check) and neither is
   * authorisation on its own. A route added without either renders a broken page to a
   * stranger — or worse, does not.
   */
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
      // The callback carries the reader back to where they were, and is built from this
      // request's own path — never reflected from a query string (that is how a sign-in
      // redirect becomes an open redirect).
      expect(decodeURIComponent(new URL(page.url()).searchParams.get("callbackUrl") ?? "")).toBe(
        path,
      );
    });
  }
});

test.describe("a signed-in non-owner", () => {
  /**
   * DEFECT THIS CATCHES: a 403, a "this case belongs to another user" message, or any other
   * response that differs between "not yours" and "does not exist". `getWorkspace(id, userId)`
   * binds `user_id = $2` in SQL and returns null for both cases; the moment someone adds a
   * friendlier error for the first case, workspace ids become enumerable.
   *
   * The comparison is byte-for-byte over the served HTML, with three **dev-server** artefacts
   * normalised away, each verified by hand against this build:
   *   · the requested id, which both responses legitimately echo into the header's own
   *     `callbackUrl` — it is the address the reader asked for, not a fact about the row;
   *   · `?v=<timestamp>` cache-busters on `next dev` asset URLs;
   *   · `:N<ts>` and `"start"/"end"` React server-timing spans in the streamed RSC payload.
   * With those removed the two documents are identical, including the RSC payload — which is
   * where a leak would actually surface. Under `next start` the last two do not appear at all.
   */
  test("gets a response byte-identical to a non-existent id", async ({ browser, baseURL }) => {
    const ownerWorkspaceId = process.env[OWNER_WORKSPACE_PATH_ENV] ?? null;

    const context = await browser.newContext({ baseURL });
    await signIn(context, "other", baseURL!);
    const page = await context.newPage();

    // A workspace that certainly exists and certainly is not this account's. Created by the
    // owner account in the vertical-slice spec, or supplied through the environment.
    const ownerContext = await browser.newContext({ baseURL });
    await signIn(ownerContext, "owner", baseURL!);
    const ownerPage = await ownerContext.newPage();
    let targetId = ownerWorkspaceId;
    if (!targetId) {
      await ownerPage.goto("/workspaces/new");
      await ownerPage.getByLabel("name this case").fill("Ownership boundary probe");
      await ownerPage.getByRole("button", { name: "start the case" }).click();
      await ownerPage.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
      targetId = new URL(ownerPage.url()).pathname.split("/").pop() ?? null;
    }
    expect(targetId, "a real workspace id is needed to make this assertion mean anything").not.toBe(
      null,
    );
    const unknownId = "00000000-0000-4000-8000-000000000000";

    const notYours = await page.request.get(`/workspaces/${targetId!}`);
    const notThere = await page.request.get(`/workspaces/${unknownId}`);

    expect(notYours.status(), "no 403 — a 403 confirms the row exists").toBe(notThere.status());

    const normalise = (html: string, id: string): string =>
      html
        .replaceAll(id, "WORKSPACE_ID")
        .replace(/\?v=\d+/g, "?v=V")
        .replace(/:N-?\d+(\.\d+)?/g, ":N0")
        .replace(/\\"(start|end)\\":-?[\d.]+/g, '\\"$1\\":0')
        .replaceAll('"])</script><script>self.__next_f.push([1,"', "");

    expect(normalise(await notYours.text(), targetId!)).toBe(
      normalise(await notThere.text(), unknownId),
    );

    // And the rendered page says nothing about ownership either.
    await page.goto(`/workspaces/${targetId!}`);
    await expectNotFoundBody(page);
    const a = await renderedIdentity(page);
    await page.goto(`/workspaces/${unknownId}`);
    await expectNotFoundBody(page);
    const b = await renderedIdentity(page);
    expect(a).toEqual(b);
    expect(a.main).not.toMatch(/permission|forbidden|not yours|another user/i);

    await context.close();
    await ownerContext.close();
  });

  /**
   * DEFECT THIS CATCHES: the export handler checking ownership *after* it starts rendering,
   * or checking it in the page but not in the handler. `app/workspaces/[id]/export/route.ts`
   * makes the order of operations the security property — session, uuid shape, ownership in
   * SQL, *then* bytes — because a leaked case file cannot be un-leaked.
   */
  test("cannot export another account's case", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, "owner", baseURL!);
    const ownerPage = await context.newPage();
    await ownerPage.goto("/workspaces/new");
    await ownerPage.getByLabel("name this case").fill("Export boundary probe");
    await ownerPage.getByRole("button", { name: "start the case" }).click();
    await ownerPage.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
    const id = new URL(ownerPage.url()).pathname.split("/").pop()!;

    const ownExport = await ownerPage.request.get(`/workspaces/${id}/export?format=md`);
    expect(ownExport.status()).toBe(200);
    expect(await ownExport.text()).toContain("Export boundary probe");

    const otherContext = await browser.newContext({ baseURL });
    await signIn(otherContext, "other", baseURL!);
    const otherPage = await otherContext.newPage();
    const stolen = await otherPage.request.get(`/workspaces/${id}/export?format=md`);
    expect(stolen.status()).not.toBe(200);
    expect(await stolen.text()).not.toContain("Export boundary probe");

    await context.close();
    await otherContext.close();
  });
});

test.describe("a plain user under /admin", () => {
  /**
   * DEFECT THIS CATCHES: a static `export const metadata` on an admin route. Next resolves
   * page metadata even when the page body calls `notFound()`, so a `user` who guessed
   * `/admin/connectors` would get the not-found body under `<title>Connectors · Cairn</title>`
   * — which discloses precisely what the 404 exists to withhold. `adminMetadata()` gates the
   * title behind the same role check; this is the test that keeps it gated.
   */
  for (const path of ["/admin", "/admin/queue", "/admin/connectors", "/admin/taxonomy"]) {
    test(`${path} is not found, and its title leaks nothing`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL });
      await signIn(context, "owner", baseURL!); // role `user`
      const page = await context.newPage();

      await page.goto(path);
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
   * DEFECT THIS CATCHES: a role gate applied in `app/admin/layout.tsx` alone. A layout guard
   * is real but is one refactor away from not being — a parallel route, or a `loading.tsx`
   * that streams before the layout resolves. `/admin/connectors` and `/admin/taxonomy` are
   * `admin`, not `editor`, because they carry the kill-switch and the taxonomy; an `editor`
   * reaching them is a privilege escalation that no test outside this one would notice.
   */
  test("an editor reaches the queue but not the connectors", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    await signIn(context, "editor", baseURL!);
    const page = await context.newPage();

    await page.goto("/admin/queue");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/not found/i);

    await page.goto("/admin/connectors");
    await expectNotFoundBody(page);
    expect(await page.title()).toMatch(/^Not found/);

    await context.close();
  });
});
