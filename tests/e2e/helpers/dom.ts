import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * DOM assertions that several specs share.
 */

/**
 * Count `<h1>` elements in the served HTML, not the live DOM: under `next dev` a leftover
 * streaming holder (`<div id="S:n">`) can duplicate the header in the DOM.
 */
export async function countServedH1(request: APIRequestContext, path: string): Promise<number> {
  const response = await request.get(path);
  const html = await response.text();
  return (html.match(/<h1[\s>]/g) ?? []).length;
}

/**
 * Whether the focused element shows a visible focus indicator. Accepts both the global
 * `:focus-visible` outline and Tailwind's `ring-2` (a box-shadow).
 */
export interface FocusStop {
  tag: string;
  label: string;
  href: string | null;
  /** Stable identity, so many similar checkboxes don't look like a keyboard trap. */
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
 * Assert the not-found body and `noindex` meta tag. Callers assert the 404 status
 * separately. (A parent `loading.tsx` above the existence guard would commit a 200 before
 * `notFound()` runs.)
 */
export async function expectNotFoundBody(
  page: Page,
  headingPattern: RegExp = /not found/i,
): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: headingPattern })).toBeVisible();
  // Auto-waiting count: `next dev` streams the head.
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).not.toHaveCount(0);
}

/**
 * Wait for load and an idle main thread. Not `networkidle` (next dev's HMR connection never
 * settles). After idle, any preconnect/prefetch would already have been requested.
 */
export async function settled(page: Page): Promise<void> {
  // `load` may never fire for some routes under next dev; don't gate on it.
  await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
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
