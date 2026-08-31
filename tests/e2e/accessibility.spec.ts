import { expect, test } from "@playwright/test";

import { countServedH1, focusIndicator } from "./helpers/dom";

/**
 * Accessibility smoke — `HANDOFF-shell.md` §4 and §10.4.
 *
 * Not an audit. `axe` is not wired in and this file does not pretend to replace it; it checks
 * the two structural properties that a refactor breaks silently and that no unit test sees:
 * the document outline, and whether the product can be operated without a mouse.
 */

const SAMPLE_ROUTES = [
  "/",
  "/directory",
  "/directory/domain-and-infrastructure",
  "/tools/shodan",
  "/tags/open-source",
  "/playbooks",
  "/search",
  "/live",
  "/live/cameras",
  "/live/cameras/tfl-piccadilly-circus",
  "/about",
  "/methodology",
  "/legal/terms",
];

test.describe("document outline", () => {
  /**
   * DEFECT THIS CATCHES: a second `<h1>` — most likely a page rendering its own header, or a
   * component that was an `h2` becoming an `h1` for a font size. A screen-reader user
   * navigating by heading then gets two "top of page"s and no way to tell which is the page.
   *
   * Asserted against the **served HTML**, not the live DOM: `HANDOFF-directory.md` §7.2
   * records that `next dev` can leave a second copy of the page header inside an unreclaimed
   * React streaming holder, which is a dev-server artefact rather than a markup defect. The
   * bytes are what a crawler and an assistive technology parse.
   */
  for (const route of SAMPLE_ROUTES) {
    test(`${route} has exactly one h1`, async ({ request }) => {
      expect(await countServedH1(request, route)).toBe(1);
    });
  }

  /**
   * DEFECT THIS CATCHES: the skip link or the `<main>` landmark disappearing in a layout
   * change. Without them a keyboard reader traverses the whole header on every page.
   */
  test("the shell provides a skip link and a main landmark", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("link", { name: /skip to main content/i })).toBeAttached();
    await expect(page.locator("main#main")).toHaveCount(1);
  });
});

/**
 * Not part of the product's tab order: `<nextjs-portal>` is the dev server's error/indicator
 * overlay, and `BODY`/`HTML` mean the traversal has walked off the end of the document. Both
 * would otherwise be reported as elements with no focus ring, which is a fact about Next's
 * development tooling and not about this application.
 */
function isFrameworkChrome(stop: { tag: string }): boolean {
  return ["NEXTJS-PORTAL", "BODY", "HTML", "NONE"].includes(stop.tag);
}

test.describe("keyboard-only traversal of the vertical slice", () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    "keyboard traversal is asserted at desktop width; the Pixel 7 project emulates touch input",
  );

  /**
   * DEFECT THIS CATCHES: `outline: none` without a replacement ring — the single commonest
   * accessibility regression there is, invisible to everyone using a mouse, and fatal to
   * anyone who is not. `globals.css` sets a global `:focus-visible` outline and most
   * primitives override it with a Tailwind ring; either satisfies this, neither being present
   * does not.
   *
   * It also catches a keyboard trap: an element that keeps focus however many times Tab is
   * pressed. The check is that focus keeps moving, because a trap is not a slow page.
   */
  test("tab to a tool and open it, with a visible focus indicator at every stop", async ({
    page,
  }) => {
    // Up to 500 Tab presses, each with a round trip to read the focused element.
    test.slow();

    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();

    const seen: string[] = [];
    let toolLink: string | null = null;
    let stopsToFirstEntry = -1;

    // Bounded. The whole header, the toolbar and every facet control sit between the top of
    // the document and the first result — 416 focusable elements on this route, of which 297
    // are tag checkboxes. 500 terminates and is not a claim that 500 is acceptable; see the
    // test below, which is where that claim is made.
    for (let step = 0; step < 500; step += 1) {
      await page.keyboard.press("Tab");
      const indicator = await focusIndicator(page);
      if (isFrameworkChrome(indicator)) continue;

      expect(
        indicator.visible,
        `no visible focus indicator on <${indicator.tag}> "${indicator.label}" at stop ${step}`,
      ).toBe(true);

      const href = indicator.href;
      seen.push(indicator.identity);

      if (href && /^\/tools\/[a-z0-9-]+$/.test(href)) {
        toolLink = href;
        stopsToFirstEntry = step + 1;
        break;
      }
    }
    test.info().annotations.push({
      type: "measurement",
      description: `Tab presses from the top of /directory to the first catalogue entry: ${stopsToFirstEntry}`,
    });

    expect(toolLink, "a catalogue entry must be reachable by Tab alone").not.toBeNull();

    // No trap: focus never sat on the same element for more than a couple of consecutive
    // presses. (Two in a row is legitimate — a composite widget can move focus internally.)
    let repeats = 1;
    for (let index = 1; index < seen.length; index += 1) {
      repeats = seen[index] === seen[index - 1] ? repeats + 1 : 1;
      expect(repeats, `focus was trapped on ${seen[index]}`).toBeLessThan(3);
    }

    await page.keyboard.press("Enter");
    await page.waitForURL(`**${toolLink!}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    /*
     * The slice's next keyboard step — "save it to a case" — cannot be exercised: there is no
     * save control anywhere in the product. See `tests/e2e/vertical-slice.spec.ts`, which
     * fails on exactly that. When the control ships it must be reachable from here by Tab,
     * and this test should be extended rather than a new one written.
     */
    const focusStops: string[] = [];
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press("Tab");
      const indicator = await focusIndicator(page);
      // Walking off the end of the document ends the traversal; it is not a missing ring.
      if (isFrameworkChrome(indicator)) break;
      expect(
        indicator.visible,
        `no visible focus indicator on <${indicator.tag}> "${indicator.label}" on the tool page`,
      ).toBe(true);
      focusStops.push(indicator.identity);
    }
    expect(new Set(focusStops).size, "focus must keep moving on the detail page").toBeGreaterThan(1);
  });

  /**
   * DEFECT THIS CATCHES — and currently *does* catch: no way to bypass the facet panel.
   *
   * WCAG 2.4.1 (Bypass Blocks) asks for a mechanism to skip a repeated block of content.
   * `/directory` has one skip link and it targets `<main>`, which begins **above** the
   * filters — so a keyboard reader arrives at the top of the page, presses Tab **362 times**
   * through the header, the toolbar and 297 tag checkboxes, and only then reaches the first
   * catalogue entry. Every one of those stops has a correct focus ring, which is why no
   * focus-indicator test finds this.
   *
   * The threshold below is a judgement, and it is a generous one: 60 stops is already a long
   * traverse. It is not arbitrary in the direction that matters — 362 is not a number any
   * reader is going to sit through, and the reader most affected is the one this product's
   * audience includes.
   *
   * The fix is small (a "skip to results" link inside `<main>`, or moving the sidebar after
   * the results in DOM order with `order` doing the visual placement), but it is a change to
   * `app/(public)/directory/page.tsx`, which QA does not own. **Left failing deliberately.**
   */
  test("the catalogue is reachable without tabbing through every facet", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();

    const stops = await page.evaluate(() => {
      const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const focusable = [...document.querySelectorAll(selector)];
      return focusable.findIndex(
        (element) =>
          element instanceof HTMLAnchorElement &&
          /^\/tools\/[a-z0-9-]+$/.test(element.getAttribute("href") ?? ""),
      );
    });

    expect(stops, "the first catalogue entry must be findable at all").toBeGreaterThan(-1);
    expect(
      stops,
      `${stops} tab stops from the top of /directory to the first entry — there is no way to bypass the facet panel`,
    ).toBeLessThanOrEqual(60);
  });

  /**
   * DEFECT THIS CATCHES: a modal surface that focus can escape or that Escape cannot close.
   * The filter sheet is the only Dialog on a public route, and Radix's trap is the thing
   * keeping it usable — a hand-rolled replacement, or `modal={false}`, would break it in a
   * way only a keyboard user would ever notice.
   */
  test("the filter sheet traps focus while it is open and releases it on Escape", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "one engine is enough for a focus-management check");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/directory");

    await page.getByRole("button", { name: /^filters/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press("Tab");
      const insideSheet = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog !== null && document.activeElement !== null
          ? dialog.contains(document.activeElement)
          : false;
      });
      expect(insideSheet, `focus left the open sheet after ${step + 1} tabs`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
