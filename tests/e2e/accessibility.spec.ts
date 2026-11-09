import { expect, test } from "@playwright/test";

import { countServedH1, focusIndicator } from "./helpers/dom";

/**
 * Accessibility smoke: document outline and keyboard-only operation. Not a full audit
 * (see axe.spec.ts).
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
  /** Exactly one h1, checked in the served HTML (see `countServedH1`). */
  for (const route of SAMPLE_ROUTES) {
    test(`${route} has exactly one h1`, async ({ request }) => {
      expect(await countServedH1(request, route)).toBe(1);
    });
  }

  /** Skip link and `<main>` landmark survive layout changes. */
  test("the shell provides a skip link and a main landmark", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("link", { name: /skip to main content/i })).toBeAttached();
    await expect(page.locator("main#main")).toHaveCount(1);
  });
});

/** Next's dev overlay, or focus walking off the end of the document. */
function isFrameworkChrome(stop: { tag: string }): boolean {
  return ["NEXTJS-PORTAL", "BODY", "HTML", "NONE"].includes(stop.tag);
}

test.describe("keyboard-only traversal of the vertical slice", () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    "keyboard traversal is asserted at desktop width; the Pixel 7 project emulates touch input",
  );

  /** Every stop has a visible focus indicator, and focus keeps moving (no traps). */
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

    // Normally ~14 presses. The bound is high so a regression reports the real count; the
    // next test enforces the limit.
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

    // No trap. Two in a row is fine (composite widgets move focus internally).
    let repeats = 1;
    for (let index = 1; index < seen.length; index += 1) {
      repeats = seen[index] === seen[index - 1] ? repeats + 1 : 1;
      expect(repeats, `focus was trapped on ${seen[index]}`).toBeLessThan(3);
    }

    await page.keyboard.press("Enter");
    await page.waitForURL(`**${toolLink!}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Keep tabbing on the detail page; focus must keep moving with visible indicators.
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
   * WCAG 2.4.1 Bypass Blocks: results come before the facet panel in DOM order.
   *
   * Counts focusables in document order, which over-counts (collapsed `<details>` contents
   * are included), so it fails conservatively. If it creeps up, fix DOM order or add a skip
   * target; collapsing more facets won't help.
   */
  test("the catalogue is reachable without tabbing through every facet", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();

    // Precondition: if the tag read degraded, the tag group is absent and there's nothing to
    // measure.
    const tagGroup = page.getByRole("group", { name: "tag" });
    test.skip(
      (await tagGroup.count()) === 0,
      "the taxonomy read degraded, so the tag facet group is absent — nothing to measure",
    );

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

  /** The filter sheet (Radix dialog) traps focus and closes on Escape. */
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

test.describe("document outline — the mobile navigation", () => {
  /**
   * No phantom "menu" heading while the sheet is closed. Radix only mounts the title while
   * open; `forceMount` or moving the title out of the dialog would break this. Checked in
   * the live DOM, since mounting is the question.
   */
  test("no 'menu' heading while the navigation sheet is closed", async ({ page }) => {
    await page.goto("/directory");
    await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "menu", exact: true }),
      "a 'menu' heading in the outline of a page whose menu is not open",
    ).toHaveCount(0);
  });

  /** The open sheet is named by a title inside the dialog. */
  test("the open sheet is titled, and the title belongs to the dialog", async ({
    page,
    isMobile,
  }) => {
    // Inside a test body the callback form of test.skip would always skip.
    test.skip(isMobile !== true, "the navigation sheet only exists below md:");

    await page.goto("/directory");
    const trigger = page.getByRole("button", { name: "open menu" });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const title = page.getByRole("heading", { name: "menu", exact: true });
    await expect(title, "exactly one, not one per page render").toHaveCount(1);
    await expect(
      dialog.getByRole("heading", { name: "menu", exact: true }),
      "the heading must be inside the dialog it names, not loose in the page outline",
    ).toHaveCount(1);

    // And it goes away again, rather than being left mounted in the outline.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(title).toHaveCount(0);
  });
});
