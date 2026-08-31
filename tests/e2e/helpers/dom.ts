import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * DOM assertions that several specs share.
 */

/**
 * Count `<h1>` elements in the **served HTML**, not in the live DOM.
 *
 * `docs/frontend/HANDOFF-directory.md` §7.2: under `next dev` a second copy of the page
 * header can persist inside an unreclaimed React streaming holder (`<div id="S:n">`), so a
 * browser DOM snapshot reports two `h1`s on routes whose markup contains one. The served
 * bytes are the contract — that is what a crawler and an assistive technology parsing the
 * document outline receive — so the assertion is made against them.
 */
export async function countServedH1(request: APIRequestContext, path: string): Promise<number> {
  const response = await request.get(path);
  const html = await response.text();
  return (html.match(/<h1[\s>]/g) ?? []).length;
}

/**
 * Does the currently focused element render a focus indicator a sighted keyboard user can
 * see?
 *
 * Two mechanisms are legitimate in this codebase and both must be accepted:
 *   - `app/globals.css` sets a global `:focus-visible { outline: 2px solid var(--ring) }`;
 *   - most primitives use Tailwind's `focus-visible:outline-none focus-visible:ring-2`,
 *     which is a `box-shadow`, not an outline.
 *
 * Asserting on one alone would fail half the product and tempt someone to "fix" the CSS to
 * suit the test.
 */
export interface FocusStop {
  tag: string;
  label: string;
  href: string | null;
  /**
   * A stable identity for the focused element. Needed because a fingerprint built from tag
   * and text alone makes 297 distinct facet checkboxes look like one element focused 297
   * times — i.e. a false keyboard trap.
   */
  identity: string;
  visible: boolean;
}

export async function focusIndicator(page: Page): Promise<FocusStop> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return { tag: element?.tagName ?? "NONE", label: "", href: null, identity: "", visible: false };
    }
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth || "0");
    const transparent = /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(style.outlineColor);
    const hasOutline = outlineWidth > 0 && style.outlineStyle !== "none" && !transparent;
    const hasRing = style.boxShadow !== "none" && style.boxShadow.trim() !== "";
    const href = element instanceof HTMLAnchorElement ? element.getAttribute("href") : null;
    const name = element.getAttribute("name") ?? "";
    const value = element.getAttribute("value") ?? "";
    return {
      tag: element.tagName,
      label: (element.textContent ?? "").trim().slice(0, 60),
      href,
      identity: `${element.tagName}#${element.id}[${name}=${value}]${href ?? ""}${(element.textContent ?? "").trim().slice(0, 40)}`,
      visible: hasOutline || hasRing,
    };
  });
}

/** The visible text of every `<h2>` inside `<main>`, in document order. */
export async function mainHeadings(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main h2")].map((h) => (h.textContent ?? "").trim()),
  );
}

/**
 * The `<title>` and the rendered text of `<main>` — the two things that must be identical
 * between "you may not see this" and "this does not exist".
 */
export async function renderedIdentity(page: Page): Promise<{ title: string; main: string }> {
  const title = await page.title();
  const main = await page.locator("main").innerText();
  return { title, main };
}

/**
 * Assert a page carries the not-found body and the `noindex` meta tag.
 *
 * **This asserts the body, not the status**, and the status is asserted separately by the
 * caller where it has the response to hand. That split is the residue of integration finding
 * **I-15**, and it is worth knowing about:
 *
 * I-15 recorded that `notFound()` returned HTTP **200** with the correct not-found body on
 * every route shape, reproduced against a production build. The suite was therefore written
 * to assert what a reader and a crawler actually receive — the rendered body and
 * `<meta name="robots" content="noindex, nofollow">` — because asserting `404` would have
 * failed on a build that was behaving as designed, and would have invited the "fix"
 * (`dynamicParams = false`) that makes an entry published through the admin UI 404 until the
 * next redeploy.
 *
 * **I-15 is now closed** (`d3d86f2`, `753cf1a`): the cause was a parent `loading.tsx` whose
 * Suspense boundary wrapped the child segment *above* its existence guard, so the shell —
 * and the 200 — was committed before the guard ran. Every route shape returns a real 404
 * again, so the callers assert the status too. The body-and-`noindex` assertions stay: they
 * are the thing the reader receives, they held throughout the period when the status did
 * not, and they are what would still be true if this regressed.
 */
export async function expectNotFoundBody(
  page: Page,
  headingPattern: RegExp = /not found/i,
): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: headingPattern })).toBeVisible();
  // A `<meta>` is never "visible", so this is a count assertion rather than a visibility one
  // — and an auto-waiting one, because `next dev` streams the head and a bare `count()` can
  // read zero from a document that has not finished arriving.
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).not.toHaveCount(0);
}

/**
 * Wait until the page has finished loading **and** the main thread has gone idle.
 *
 * `networkidle` is not usable here: `next dev` holds a hot-reload connection open, so it
 * never settles and the wait becomes a 30-second timeout under parallel workers. And a fixed
 * `waitForTimeout` would be exactly the arbitrary sleep this suite forbids.
 *
 * `requestIdleCallback` is the browser's own answer to "is there any work left": it fires
 * once the load event has gone and hydration has stopped occupying the main thread. That is
 * the moment after which a preconnect, a prefetch or an eagerly-mounted embed would already
 * have been requested — which is what the outbound assertions need to be true *of*.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.waitForFunction(
    () => (window as unknown as { next?: { router?: unknown } }).next?.router !== undefined,
    null,
    { timeout: 15_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 5_000 });
      }),
  );
}
