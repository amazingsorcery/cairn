import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility sweep over `/map` and the Toolbench tools.
 *
 * Run against a production build: under `next dev` React's Suspense staging container can
 * produce a duplicate `<h1>`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:3300 pnpm exec playwright test --project=chromium \
 *     tests/e2e/toolbench-accessibility.spec.ts
 */

const TOOLBENCH = [
  "/toolbench",
  "/toolbench/coordinates",
  "/toolbench/dns-lookup",
  "/toolbench/certificate-transparency",
  "/toolbench/ip-intelligence",
  "/toolbench/wayback-explorer",
  "/toolbench/broadcast-finder",
  "/toolbench/overpass-builder",
  "/toolbench/image-metadata",
  "/toolbench/metadata-scrubber",
  "/toolbench/hashes-and-encodings",
  "/toolbench/sun-position",
  "/toolbench/timestamps",
  "/toolbench/registry-lookup",
  "/toolbench/reverse-image-search",
  "/toolbench/imagery-comparator",
];

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Visible headings only: `hidden` subtrees are React's streaming staging container. */
async function headingOutline(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter((h) => (h as HTMLElement).offsetParent !== null || h.tagName === "H1")
      .filter((h) => !h.closest("[hidden]"))
      .map((h) => h.tagName.toLowerCase()),
  );
}

test.describe("headings, one h1, no level skip", () => {
  for (const path of ["/map", ...TOOLBENCH]) {
    test(`${path}`, async ({ page }) => {
      // `/map` streams; under load `load` can fire while only `loading.tsx` has arrived.
      await page.goto(path, { waitUntil: "networkidle" });
      await page.locator("h1").first().waitFor({ state: "attached", timeout: 15_000 });
      const outline = await headingOutline(page);
      const h1s = outline.filter((t) => t === "h1");
      expect(h1s, `${path} must have exactly one visible h1`).toHaveLength(1);

      let previous = 1;
      const skips: string[] = [];
      for (const tag of outline.slice(1)) {
        const level = Number(tag[1]);
        if (level > previous + 1) skips.push(`${previous}->${level}`);
        previous = level;
      }
      expect(skips, `${path} outline ${outline.join(" ")}`).toEqual([]);
    });
  }
});

test.describe("axe: no serious or critical violations", () => {
  for (const path of ["/map", "/toolbench", "/toolbench/wayback-explorer", "/toolbench/image-metadata", "/toolbench/overpass-builder"]) {
    test(`${path}`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const bad = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        bad.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`),
      ).toEqual([]);
    });
  }
});

test("map: no WebGL library is present before the reader opts in", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();
  const webgl = await page.evaluate(() => "maplibregl" in window || "deck" in window);
  expect(webgl, "WebGL libraries must not be present before opt-in").toBe(false);
  const canvases = await page.locator("canvas").count();
  expect(canvases, "no canvas before opt-in").toBe(0);
});

test("map: reachable by keyboard from the top of the page to the first table row", async ({
  page,
}) => {
  await page.goto("/map");
  const total = await page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).offsetParent !== null).length,
    FOCUSABLE,
  );
  // Recorded, not asserted.
  test.info().annotations.push({ type: "focusable-count", description: String(total) });

  // The last layer toggle must be reachable within a short traversal.
  let steps = 0;
  let landed = "";
  for (; steps < 60; steps += 1) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? "");
    if (id === "map-layer-cameras") {
      landed = id;
      break;
    }
  }
  expect(landed, `never reached the last layer toggle in ${steps} Tab presses`).toBe(
    "map-layer-cameras",
  );
  expect(steps, "tab stops from the top of /map to the last layer toggle").toBeLessThan(30);
});

test("map: focus is visible at every stop for the first 40 tab stops", async ({ page }) => {
  await page.goto("/map");
  const missing: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    // The ring may be on an ancestor (e.g. `has-[:focus-visible]:ring-2` on the layer row
    // label), so check up to three ancestors. Transparent shadows don't count.
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const opaqueShadow = (value: string): boolean =>
        value !== "none" &&
        value
          .split(/,(?![^(]*\))/)
          .some((part) => !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(part) && /\d/.test(part));
      let node: HTMLElement | null = el;
      let visible = false;
      for (let depth = 0; depth < 4 && node && !visible; depth += 1) {
        const s = getComputedStyle(node);
        const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
        visible = outline || opaqueShadow(s.boxShadow);
        node = node.parentElement;
      }
      return {
        visible,
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") ?? el.id ?? el.textContent ?? "").trim().slice(0, 40),
      };
    });
    if (info && !info.visible) missing.push(`${i}: <${info.tag}> ${info.label}`);
  }
  expect(missing).toEqual([]);
});

test("map: every control has an accessible name", async ({ page }) => {
  await page.goto("/map");
  const unnamed = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll("button, input, select, textarea, a[href]")) {
      const e = el as HTMLElement;
      if (e.offsetParent === null) continue;
      const labelled = e.getAttribute("aria-label") ?? e.getAttribute("aria-labelledby");
      const id = e.getAttribute("id");
      const hasLabelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null : false;
      const title = e.getAttribute("title");
      const text = (e.textContent ?? "").trim();
      if (!labelled && !hasLabelEl && !title && text.length === 0) {
        out.push(`<${e.tagName.toLowerCase()}> ${e.outerHTML.slice(0, 90)}`);
      }
    }
    return out;
  });
  expect(unnamed).toEqual([]);
});

test("map: the opt-in is operable by keyboard and starts WebGL only then", async ({ page }) => {
  await page.goto("/map");
  const optIn = page.getByRole("button", { name: /load the map/i }).first();
  await expect(optIn).toBeVisible();
  await expect(optIn).toHaveAccessibleName(/connects you to/i);
  await optIn.focus();
  await expect(optIn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 25_000 });
  // The layer panel and caveats stay after the map opens.
  await expect(page.locator("#map-layer-earthquakes")).toBeVisible();
  await expect(page.getByRole("heading", { name: /how to read this map/i })).toBeVisible();
});

test("toolbench: every tool page states where the work happens", async ({ page }) => {
  const missing: string[] = [];
  for (const path of TOOLBENCH.filter((p) => p !== "/toolbench")) {
    await page.goto(path);
    const text = (await page.locator("main").innerText()).toLowerCase();
    // Each tool page must state where the work happens: in the browser, or which third
    // party is contacted and that we don't relay it.
    const states =
      text.includes("runs in your browser") ||
      text.includes("happens on your own machine") ||
      text.includes("nothing is uploaded") ||
      text.includes("not uploaded") ||
      text.includes("nothing goes to this site") ||
      text.includes("straight from its source") ||
      text.includes("not through us") ||
      text.includes("from our server") ||
      text.includes("this site's server");
    if (!states) missing.push(path);
  }
  expect(missing, "each tool page must state the privacy posture").toEqual([]);
});

test("toolbench: prefers-reduced-motion is honoured on the map route", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/map");
  const rules = await page.evaluate(() => {
    let count = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
            count += 1;
          }
        }
      } catch {
        /* cross-origin sheet */
      }
    }
    return count;
  });
  expect(rules).toBeGreaterThan(0);
  await context.close();
});
