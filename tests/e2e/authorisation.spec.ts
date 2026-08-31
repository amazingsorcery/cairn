import { expect, test } from "@playwright/test";

import { createCase, deleteCase } from "./helpers/cases";
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
 * On the status code: integration finding **I-15** (now closed, `d3d86f2`/`753cf1a`) meant
 * `notFound()` returned 200 with the right body. It returns a real 404 again, so the denial
 * paths assert the status **and** the body — see `expectNotFoundBody` for why both.
 */

const OWNER_WORKSPACE_PATH_ENV = "E2E_OWNER_WORKSPACE_ID";

/**
 * A long-lived case belonging to the `owner` account, used as the "exists but is not yours"
 * target. Created once and then reused, rather than created and deleted per run: this test
 * needs a workspace that certainly exists, and churning a row per run to prove it is waste.
 */
const OWNER_PROBE_CASE = "Ownership boundary probe";

/**
 * Split a response into the two things that carry information, with the dev server's
 * scheduling artefacts removed.
 *
 * A literal `expect(htmlA).toBe(htmlB)` is the assertion one wants, and against `next start`
 * it is the assertion one gets. Against `next dev` it is load-sensitive for reasons that have
 * nothing to do with authorisation: React streams the document in flushes, and **where** the
 * flush boundaries fall, **how many** suspense holders are inlined, and what those holders
 * are numbered (`S:2` vs `S:3`) all depend on how busy the machine was. Two responses with
 * byte-identical content can therefore differ in framing.
 *
 * So the comparison canonicalises the framing and nothing else:
 *   · `markup`  — the document with every `<script>` removed and the streaming holder ids
 *                 normalised. Everything a browser paints.
 *   · `payload` — every `self.__next_f.push([1,"…"])` chunk concatenated in order. The RSC
 *                 stream, which is where a leak would actually surface, reassembled so that
 *                 *where* it was cut does not matter.
 * Plus three values that are timestamps rather than content: the `?v=` asset cache-buster and
 * the `:N…` / `"start"`/`"end"` React server-timing spans.
 *
 * The workspace id itself is replaced in both: each response legitimately echoes the id that
 * was *requested* into the header's own `callbackUrl`. That is the address the reader typed,
 * not a fact about whether a row exists.
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
   * The comparison is byte-for-byte over both halves of the response — the painted markup and
   * the streamed RSC payload — with the dev server's streaming and timing artefacts
   * canonicalised away. See `canonicalise` above for exactly what is removed and why.
   */
  test("gets a response byte-identical to a non-existent id", async ({ browser, baseURL }) => {
    // Two contexts, two page loads and a workspace creation against `next dev`, which
    // compiles routes on first request. Comfortably inside the budget on `next start`; this
    // keeps it inside it locally too.
    test.slow();

    const context = await browser.newContext({ baseURL });
    await signIn(context, "other", baseURL!);
    const page = await context.newPage();

    // A workspace that certainly exists and certainly is not this account's: an existing one
    // belonging to the owner account, or a new one if that account has none yet.
    const ownerContext = await browser.newContext({ baseURL });
    await signIn(ownerContext, "owner", baseURL!);
    const ownerPage = await ownerContext.newPage();
    let targetId = process.env[OWNER_WORKSPACE_PATH_ENV] ?? null;
    if (!targetId) {
      await ownerPage.goto("/workspaces");
      /*
       * Wait for the list to RESOLVE before looking in it. Two traps here, both of which bit:
       *   · the list streams behind `loading.tsx`, and `count()` does not auto-wait, so a
       *     bare count reads "no cases" off the skeleton and creates a fresh row every run;
       *   · waiting for "the probe, or the empty state" is not exhaustive — the common case
       *     is *other* cases existing and the probe not, and that wait can only time out.
       * So: wait for any case link or the empty state, THEN look for the probe.
       */
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
    expect(notYours.status(), "and both are a real 404 (I-15 is closed)").toBe(404);

    const notYoursHtml = await notYours.text();
    const notThereHtml = await notThere.text();
    const served = canonicalise(notYoursHtml, targetId!);
    const absent = canonicalise(notThereHtml, unknownId);

    expect(served.markup, "the served markup must not differ").toBe(absent.markup);

    /*
     * The RSC payload comparison runs against a production build only.
     *
     * In `next dev` the payload carries React's owner stacks, server-timing spans and the
     * Next devtools segment tree — development instrumentation whose row numbering shifts
     * with scheduling, so two byte-identical *renders* produce different payload bytes under
     * load. None of it exists in `next build && next start`, which is what the Playwright
     * `webServer` block runs and therefore what CI asserts against. Comparing it in dev would
     * be asserting on the dev server's instrumentation, not on this application.
     */
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

  /**
   * DEFECT THIS CATCHES: the export handler checking ownership *after* it starts rendering,
   * or checking it in the page but not in the handler. `app/workspaces/[id]/export/route.ts`
   * makes the order of operations the security property — session, uuid shape, ownership in
   * SQL, *then* bytes — because a leaked case file cannot be un-leaked.
   */
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

    const denied = await page.goto("/admin/connectors");
    expect(denied?.status(), "an editor is refused connectors with a 404, not a 403").toBe(404);
    await expectNotFoundBody(page);
    expect(await page.title()).toMatch(/^Not found/);

    await context.close();
  });
});
