import { expect, test } from "@playwright/test";

import { STUB_PNG, isOutbound, settled, watchOutbound } from "./helpers/net";

/**
 * `/live/cameras` and `/live/cameras/[slug]` — ADR 0011, ADR 0015, architecture HANDOFF §9.10.
 *
 * This is the file `docs/frontend/HANDOFF-live.md` §8 asks for by name: "A Playwright network
 * assertion that `/live/cameras` produces zero requests to any operator origin until a click.
 * ADR 0015 §4 names it and it is the single most regressible thing in this section."
 *
 * The camera slugs below are seeded, published and `embed_permitted = true`. Their operator
 * origins are real (`s3-eu-west-1.amazonaws.com`, `weathercam.digitraffic.fi`) and the suite
 * never contacts them: the load-time tests **abort** every cross-origin request, and the
 * click-to-load test **stubs** the operator's image with a 1×1 PNG. Nothing here depends on
 * TfL or Fintraffic being up.
 */

const EMBEDDABLE_CAMERA = "tfl-piccadilly-circus";

/**
 * The exact licence line TfL obliges us to render. Matched exactly rather than by substring:
 * the camera's `embed_notes` quote the same phrase when explaining why embedding is
 * permitted, and a loose match cannot tell an obligation being met from an obligation being
 * described.
 */
const TFL_ATTRIBUTION =
  "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights. Geomni UK Map data © and database rights.";
const REGISTRY_ONLY_CAMERA = "nps-webcams-network";

test.describe("live cameras — the zero-request guarantee", () => {
  /**
   * DEFECT THIS CATCHES: a `<link rel="preconnect">`, a `dns-prefetch`, a thumbnail grid, a
   * `loading="lazy"` operator image, or `listCameras()` starting to select `embed_url` — any
   * of which silently hands every camera operator the IP address of everyone who merely
   * browsed the registry. Architecture HANDOFF §9.10 forbids each by name precisely because
   * they are the sensible-looking optimisations somebody will add.
   */
  test("the listing makes no request to any origin but our own", async ({ page, baseURL }) => {
    const outbound = await watchOutbound(page, baseURL!, { block: true });

    await page.goto("/live/cameras");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settled(page);

    expect(outbound.urls, "the camera registry must contact nobody on load").toEqual([]);
    // Belt and braces: no image element exists at all, so there is nothing that *could* load.
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]').count()).toBe(0);
  });

  /**
   * DEFECT THIS CATCHES: the same regression on the detail page, which is the page that
   * actually holds an embed URL and is therefore the one where an auto-load would be a
   * one-line change. A reader arriving here from a search result has been told nothing yet;
   * the disclosure and the silence both have to hold before their click.
   */
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

    // The disclosure is in the button label, not only in a paragraph above it (ADR 0015 §2):
    // the label is the string the reader reads at the moment of deciding.
    await expect(
      page.getByRole("button", { name: /load this view — connects you to/i }),
    ).toBeVisible();
  });

  /**
   * DEFECT THIS CATCHES: (a) an `unoptimized` prop dropped from `next/image`, which would
   * route the operator's bytes through `/_next/image` on our origin and make us the
   * redistributor ADR 0011 §2 refuses — the request would go to our own origin and the
   * operator-origin count would be zero; (b) a `srcset` fan-out turning one request into
   * five; (c) `referrerPolicy` being dropped, which tells the operator which of our pages
   * the reader came from.
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
      // Stubbed, never fetched: the assertion is about *our* behaviour, and a test that
      // depends on TfL's S3 bucket being up is not a test.
      await route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG });
    });

    await page.goto(`/live/cameras/${EMBEDDABLE_CAMERA}`);
    await settled(page);
    expect(operatorRequests).toEqual([]);

    // The registry entry carries the attribution once before the click; the embed adds a
    // second copy beside the image. ADR 0011 rule 2 wants it *next to the data*, and
    // counting is how a spec written in roles and text can tell "beside the image" from
    // "somewhere on the page".
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

    // ADR 0011 rule 2: the licence attribution renders next to the image, not in the footer.
    await expect
      .poll(() => attribution.count(), { message: "attribution renders wherever the image is" })
      .toBe(2);
  });

  /**
   * DEFECT THIS CATCHES: an entry whose operator forbids embedding acquiring an embed anyway
   * — the difference between "intentionally published and licensed for reuse" and "reachable",
   * which product-brief §2 makes the whole basis of the Live pillar.
   */
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
   * DEFECT THIS CATCHES: a switched-off connector rendering a spinner, an empty region, or
   * nothing at all instead of saying what is stale and since when. ADR 0014 and `states.md`
   * §5.11: the Live surfaces have three states and `unavailable` must say what is wrong and
   * how old the last good data is. Never a spinner.
   *
   * Both camera connectors (`transport-for-london`, `fintraffic-digitraffic`) are seeded
   * `enabled = false` — fail closed — so this state is reachable with no mutation and no
   * network, which is why it is asserted here rather than on `/live/flights`.
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

    // `states.md` §0: there are exactly two spinners in the product and neither is here.
    expect(await page.locator('[role="progressbar"], .animate-spin').count()).toBe(0);
  });
});
