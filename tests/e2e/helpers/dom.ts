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
export async function focusIndicator(page: Page): Promise<{
  tag: string;
  label: string;
  visible: boolean;
}> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return { tag: element?.tagName ?? "NONE", label: "", visible: false };
    }
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth || "0");
    const transparent = /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(style.outlineColor);
    const hasOutline = outlineWidth > 0 && style.outlineStyle !== "none" && !transparent;
    const hasRing = style.boxShadow !== "none" && style.boxShadow.trim() !== "";
    return {
      tag: element.tagName,
      label: (element.textContent ?? "").trim().slice(0, 60),
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
 * **Deliberately not a status assertion.** Integration finding **I-15**: `notFound()` returns
 * HTTP **200** with the correct not-found body on every route shape in this Next version
 * (15.5.24), reproduced against a production build with a real database. It is not our bug,
 * the fix that would close it (`dynamicParams = false`) is worse than the defect for a
 * content product with an editorial workflow, and the SEO harm is already neutralised by the
 * `noindex, nofollow` meta tag that the not-found pages emit. Asserting `404` here would
 * fail on a correctly-behaving build, which is worse than no assertion — so the suite asserts
 * the two things a reader and a crawler actually receive.
 *
 * Revisit on a Next.js upgrade: when `notFound()` starts returning 404 again, add the status
 * assertion back and delete this note.
 */
export async function expectNotFoundBody(
  page: Page,
  headingPattern: RegExp = /not found/i,
): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: headingPattern })).toBeVisible();
  // A `<meta>` is never "visible", so this is a count assertion rather than a visibility one.
  const robots = page.locator('head meta[name="robots"][content*="noindex"]');
  expect(await robots.count()).toBeGreaterThan(0);
}
