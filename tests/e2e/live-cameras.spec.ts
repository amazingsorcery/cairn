import { expect, test } from "@playwright/test";

import { settled } from "./helpers/dom";
import { STUB_PNG, isOutbound, watchOutbound } from "./helpers/net";

/**
 * `/live/cameras`: zero requests to any operator origin until the reader clicks.
 *
 * Operators are never actually contacted: load-time tests abort cross-origin requests, and
 * click-to-load stubs the image with a 1x1 PNG.
 */

const EMBEDDABLE_CAMERA = "tfl-piccadilly-circus";

/** TfL's required attribution. Exact match, since `embed_notes` quotes the same phrase. */
const TFL_ATTRIBUTION =
  "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights. Geomni UK Map data © and database rights.";
const REGISTRY_ONLY_CAMERA = "nps-webcams-network";

test.describe("live cameras — the zero-request guarantee", () => {
  /** No preconnect, prefetch, thumbnails or lazy operator images on the listing. */
  test("the listing makes no request to any origin but our own", async ({ page, baseURL }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    await page.goto("/live/cameras");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settled(page);

    expect(outbound.urls, "the camera registry must contact nobody on load").toEqual([]);
    // No image element at all.
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]').count()).toBe(0);
  });

  /** Same on the detail page, which holds the embed URL. */
  test("a camera detail page makes no request to any origin but our own before a click", async ({
    page,
    baseURL,
  }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    await page.goto(`/live/cameras/${EMBEDDABLE_CAMERA}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settled(page);

    expect(outbound.urls, "nothing may leave before the reader chooses").toEqual([]);
    expect(await page.locator("img").count()).toBe(0);

    // The disclosure is in the button label itself.
    await expect(
      page.getByRole("button", { name: /load this view — connects you to/i }),
    ).toBeVisible();
  });

  /**
   * Catches: dropping `unoptimized` (bytes proxied through `/_next/image`), a `srcset`
   * multiplying requests, and a missing `referrerPolicy`.
   */
  test("click-to-load issues exactly one operator request, with no referrer", async ({
    page,
    baseURL,
  }) => {
    const operatorRequests: string[] = [];

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (!isOutbound(url, baseURL!)) {
        await route.continue();
        return;
      }
      operatorRequests.push(url);
      // Stubbed, never fetched.
      await route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG });
    });

    await page.goto(`/live/cameras/${EMBEDDABLE_CAMERA}`);
    await settled(page);
    expect(operatorRequests).toEqual([]);

    // Once before the click; the embed adds a second copy beside the image.
    const attribution = page.getByText(TFL_ATTRIBUTION, { exact: true });
    expect(await attribution.count()).toBe(1);

    await page.getByRole("button", { name: /load this view — connects you to/i }).click();

    const image = page.getByRole("img", { name: /camera view:/i });
    await expect(image).toBeVisible();

    expect(await image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await image.getAttribute("loading")).toBe("eager");
    expect(await image.getAttribute("srcset"), "a srcset would multiply the request").toBeNull();

    const src = (await image.getAttribute("src")) ?? "";
    expect(src, "the src must be the operator's own URL, not /_next/image").not.toContain(
      "/_next/image",
    );
    expect(isOutbound(src, baseURL!)).toBe(true);

    await expect
      .poll(() => operatorRequests.length, {
        message: "exactly one request, to the operator, after exactly one click",
      })
      .toBe(1);

    // Attribution renders next to the image.
    await expect
      .poll(() => attribution.count(), { message: "attribution renders wherever the image is" })
      .toBe(2);
  });

  test("a camera that may not be embedded renders no image and says why", async ({
    page,
    baseURL,
  }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    await page.goto(`/live/cameras/${REGISTRY_ONLY_CAMERA}`);
    await expect(page.getByText(/No view is embedded here/i)).toBeVisible();
    await expect(page.getByText(/doesn’t permit embedding this view/i)).toBeVisible();

    await settled(page);
    expect(outbound.urls).toEqual([]);
    expect(await page.locator("img").count()).toBe(0);
  });
});

test.describe("live cameras — degraded state", () => {
  /**
   * A disabled connector says what is stale and since when, never a spinner. Camera
   * connectors are seeded disabled, so this needs no mutation or network.
   */
  test("a disabled connector renders the degraded state, not a spinner", async ({
    page,
    baseURL,
  }) => {
    await watchOutbound(page, baseURL!, { block: true });
    await page.goto(`/live/cameras/${EMBEDDABLE_CAMERA}`);

    await expect(
      page.getByText(/This feed’s metadata refresh is switched off/i),
    ).toBeVisible();
    await expect(
      page.getByText(/We haven’t been able to re-check this feed’s details since/i),
    ).toBeVisible();

    // The connector's state is stated as a fact in the registry entry, not implied.
    await expect(page.getByText("switched off", { exact: true })).toBeVisible();

    // No spinner here.
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });
});
