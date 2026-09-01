import { afterEach, describe, expect, it, vi } from "vitest";

import { CAMERA_PROVIDERS } from "./cameras";
import { resetSourceRuntime } from "./http";
import { LINK_ONLY_REGISTRY, normaliseCameras, trafficCameras } from "./traffic-cameras";
import { jsonResponse, testContext } from "./__fixtures__/context";

/**
 * Real payloads, captured verbatim on 2026-09-01 from the two operators' own catalogues.
 * The per-provider mapping is tested next to each provider; this file tests the composition:
 * that both catalogues reach the layer, that one failing takes only itself off, and that
 * nothing is capped on the way through.
 */
import fintrafficFixture from "./__fixtures__/fintraffic-weathercams.json";
import tflFixture from "./__fixtures__/tfl-jamcams.json";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

const TFL_URL = "https://api.tfl.gov.uk/Place/Type/JamCam";
const FINTRAFFIC_URL = "https://tie.digitraffic.fi/api/weathercam/v1/stations";

const TFL_CAMERAS = tflFixture.length;
const FINTRAFFIC_CAMERAS = fintrafficFixture.features.reduce(
  (total, station) => total + station.properties.presets.length,
  0,
);

/** Answer each provider's catalogue URL, or whatever the test says for one of them. */
function stubCatalogues(
  overrides: Readonly<Record<string, () => Promise<Response> | Response>> = {},
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const override = overrides[url];
    if (override) return Promise.resolve(override());
    if (url === TFL_URL) return Promise.resolve(jsonResponse(tflFixture));
    if (url === FINTRAFFIC_URL) return Promise.resolve(jsonResponse(fintrafficFixture));
    throw new Error(`unexpected request to ${url}`);
  });
}

describe("traffic-cameras", () => {
  it("serves both operators' full catalogues, not a hand-copied subset", async () => {
    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * THE BUG THIS REPLACES. The adapter used to serve ten cameras from
     * `content/cameras/*.json` while these two operators published 890 and 2,279. The count
     * is asserted exactly, not as "more than ten": a cap that looks complete is the failure
     * this build has hit repeatedly, and an exact count is what makes one visible.
     */
    expect(result.features).toHaveLength(TFL_CAMERAS + FINTRAFFIC_CAMERAS);

    for (const feature of result.features) {
      expect(feature.kind).toBe("cameras");
      expect(feature.properties.licence).not.toBe("");
      expect(feature.properties.mediaForms).not.toBe("");
    }
  });

  it("imposes no ceiling of its own, and honours one the caller asks for", async () => {
    stubCatalogues();
    const all = await trafficCameras.fetch({}, testContext());
    const capped = await trafficCameras.fetch({ limit: 12 }, testContext());
    if (!all.ok || !capped.ok) throw new Error("both polls should succeed");

    expect(capped.features).toHaveLength(12);
    /*
     * The caller asked for twelve; nothing between here and the map chose a smaller number.
     * Unasked, every camera in both catalogues comes back — which for the full 2026-09-01
     * catalogues is 890 + 2,279 and here is the whole of both fixtures.
     */
    expect(all.features).toHaveLength(TFL_CAMERAS + FINTRAFFIC_CAMERAS);
  });

  it("carries a per-camera attribution, because two licences cannot share one string", async () => {
    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");

    for (const feature of result.features) {
      if (feature.properties.attributionRequired) {
        expect(feature.properties.attribution).toBeTruthy();
      }
    }
    // TfL's terms require their exact wording including the Ordnance Survey notice; CC BY
    // requires Fintraffic's. A blended layer-level string would satisfy neither licence.
    const strings = new Set(result.features.map((f) => f.properties.attribution));
    expect(strings.size).toBeGreaterThan(1);
  });

  it("names each media form separately and never calls a refreshed file live", async () => {
    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");

    const tfl = result.features.filter((f) => f.properties.providerSlug === "tfl-jamcams");
    const fin = result.features.filter(
      (f) => f.properties.providerSlug === "fintraffic-weathercams",
    );
    expect(tfl.length).toBe(TFL_CAMERAS);
    expect(fin.length).toBe(FINTRAFFIC_CAMERAS);

    for (const feature of tfl) expect(feature.properties.mediaForms).toBe("still,video");
    for (const feature of fin) expect(feature.properties.mediaForms).toBe("still");
    // Neither operator publishes a live manifest, so nothing on this layer claims one.
    for (const feature of result.features) {
      expect(feature.properties.hasLiveStream).toBe(false);
      expect(feature.properties.streamUrl).toBeNull();
    }
  });

  it("hands every media URL to the client and fetches none of them", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url === TFL_URL) return Promise.resolve(jsonResponse(tflFixture));
      if (url === FINTRAFFIC_URL) return Promise.resolve(jsonResponse(fintrafficFixture));
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");

    /*
     * PRODUCT-BRIEF §2b, AS A TEST RATHER THAN A COMMENT. Two requests left the building:
     * one catalogue per operator. Not one frame, not one clip. Relaying video through this
     * deployment is roughly 1000x its whole bandwidth budget.
     */
    expect(seen).toEqual([TFL_URL, FINTRAFFIC_URL].sort((a, b) => seen.indexOf(a) - seen.indexOf(b)));
    expect(seen).toHaveLength(2);
    for (const feature of result.features) {
      const media = [feature.properties.stillUrl, feature.properties.videoUrl].filter(Boolean);
      for (const url of media) expect(seen).not.toContain(url);
    }
  });

  it("drops one provider that changed shape, and keeps the other", async () => {
    stubCatalogues({
      [TFL_URL]: () => jsonResponse([{ id: "JamCams_1", commonName: "moved" }]),
    });
    const result = await trafficCameras.fetch({}, testContext());

    // A schema failure disables one provider, not the layer. Finland is still on the map.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.features).toHaveLength(FINTRAFFIC_CAMERAS);
    expect(result.features.every((f) => f.properties.providerSlug === "fintraffic-weathercams")).toBe(
      true,
    );
  });

  it("keeps one operator's refusal from silencing the others", async () => {
    /*
     * `fetchUpstream` opens a cooldown on a 429 and refuses later calls under that slug.
     * Sharing one slug across operators would mean Fintraffic refusing us takes London off
     * the map — the "one bad upstream must never break the layer" failure, from the inside.
     */
    stubCatalogues({
      [FINTRAFFIC_URL]: () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
    });
    const first = await trafficCameras.fetch({}, testContext());
    if (!first.ok) throw new Error("TfL should still have answered");
    expect(first.features).toHaveLength(TFL_CAMERAS);

    // And the cooldown that refusal opened does not follow TfL into the next poll either.
    stubCatalogues({
      [FINTRAFFIC_URL]: () => new Response("", { status: 429 }),
    });
    const second = await trafficCameras.fetch({}, testContext());
    if (!second.ok) throw new Error("TfL should still have answered");
    expect(second.features).toHaveLength(TFL_CAMERAS);
  });

  it("reports a failure only when every provider failed", async () => {
    stubCatalogues({
      [TFL_URL]: () => new Response("", { status: 503 }),
      [FINTRAFFIC_URL]: () => new Response("", { status: 500 }),
    });
    const result = await trafficCameras.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("upstreamError");
    if (result.failure.kind !== "upstreamError") return;
    // Both are named, because a layer renders one state and reporting only the first would
    // send an operator to fix half the problem.
    expect(result.failure.message).toContain("tfl-jamcams");
    expect(result.failure.message).toContain("fintraffic-weathercams");
  });

  it("keeps a shared refusal as a refusal, so the fix stays 'back off'", async () => {
    stubCatalogues({
      [TFL_URL]: () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
      [FINTRAFFIC_URL]: () => new Response("", { status: 429, headers: { "retry-after": "90" } }),
    });
    const result = await trafficCameras.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok || result.failure.kind !== "rateLimited") throw new Error("expected rateLimited");
    // The longest wait wins: backing off for less than the longest re-enters the refusal.
    expect(result.failure.retryAfterSeconds).toBe(90);
  });

  it("reports the oldest observation, not the freshest", async () => {
    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");
    // Fintraffic states its own `dataUpdatedTime`; TfL publishes none, so its observation is
    // the read. A mixed payload is only as fresh as its stalest part.
    expect(result.observedAt.toISOString()).toBe(
      new Date(fintrafficFixture.dataUpdatedTime).toISOString(),
    );
  });

  it("excludes link-only providers, whose embed permission was never confirmed", async () => {
    // The separate file exists precisely because an embed permission could not be confirmed.
    // Rendering those on an embedding layer would undo that judgement.
    expect(normaliseCameras([LINK_ONLY_REGISTRY], {})).toEqual([]);

    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");
    const ids = new Set(result.features.map((f) => f.id));
    expect(ids.has("statens-vegvesen-webkamera-network")).toBe(false);
  });

  it("does not double-count an operator that content/cameras also describes", async () => {
    /*
     * `content/cameras/transport-for-london.json` and `fintraffic-digitraffic.json` are still
     * committed — they seed the operator registry, the admin page and the CSP — but their ten
     * hand-copied cameras are a subset of the catalogues fetched above. Emitting both would
     * put ten duplicate dots on the map.
     */
    stubCatalogues();
    const result = await trafficCameras.fetch({}, testContext());
    if (!result.ok) throw new Error("both catalogues should parse");
    const ids = new Set(result.features.map((f) => f.id));
    expect(ids.has("tfl-piccadilly-circus")).toBe(false);
    expect(ids.has("digitraffic-inkoo-kt51-towards-inkoo")).toBe(false);
    expect(result.features).toHaveLength(TFL_CAMERAS + FINTRAFFIC_CAMERAS);
  });

  it("never hands out a camera it may not embed, even from an embedding file", () => {
    const features = normaliseCameras(
      [
        {
          provider: { slug: "p", name: "Provider", attribution: "credit", licence: "test" },
          cameras: [
            {
              slug: "not-permitted",
              name: "Not permitted",
              operator: "op",
              jurisdiction: "GB",
              locationLabel: "somewhere",
              latitude: 51,
              longitude: 0,
              sourceUrl: "https://example.com",
              embedUrl: "https://example.com/a.jpg",
              embedPermitted: false,
              attributionRequired: true,
              attribution: "credit",
              licence: "test",
              subject: "traffic",
              confidence: "verified",
              lastVerifiedAt: "2026-08-31",
            },
          ],
        },
      ],
      {},
    );
    expect(features).toEqual([]);
  });

  it("normalises a live envelope with no network at all", () => {
    // The public `normalise` takes the same shape `fetch` builds, so a captured payload can
    // be handed straight in — the test that actually catches an upstream shape change.
    const features = normaliseCameras([{ cameraProvider: "tfl-jamcams", payload: tflFixture }], {});
    expect(features).toHaveLength(TFL_CAMERAS);
  });

  it("degrades rather than throwing if the payload stops matching its schema", () => {
    const broken = [{ provider: {}, cameras: "not an array" }];
    expect(trafficCameras.responseSchema.safeParse(broken).success).toBe(false);
    expect(normaliseCameras(broken, {})).toEqual([]);
  });

  it("applies a viewport", async () => {
    stubCatalogues();
    const all = await trafficCameras.fetch({}, testContext());
    const london = await trafficCameras.fetch(
      { bbox: { west: -0.5, south: 51.3, east: 0.3, north: 51.7 } },
      testContext(),
    );
    if (!all.ok || !london.ok) throw new Error("both catalogues should parse");
    expect(london.features.length).toBeLessThan(all.features.length);
    expect(london.features.length).toBeGreaterThan(0);
    // London is TfL only. Finland's cameras are 1,500 km outside that box.
    expect(london.features.every((f) => f.properties.providerSlug === "tfl-jamcams")).toBe(true);
  });

  it("reports per provider, so a half-dead layer is visible to an operator", async () => {
    stubCatalogues({ [TFL_URL]: () => new Response("", { status: 503 }) });
    const health = await trafficCameras.healthcheck(testContext());
    // Healthy overall — Finland still renders — but the detail names what is missing, which
    // is the case a layer-level "3,169 cameras" would hide completely.
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("tfl-jamcams");
    expect(health.detail).toContain("HTTP 503");
    expect(health.detail).toContain("fintraffic-weathercams");
  });

  it("declares a TTL that respects the slowest-changing thing it fetches", () => {
    // A catalogue of which cameras exist, not their imagery. Digitraffic's instructions say
    // there is no gain calling too often; TfL allows 500 calls a minute and we make four a day.
    expect(trafficCameras.ttlSeconds).toBeGreaterThanOrEqual(3600);
    expect(trafficCameras.staleWhileRevalidateSeconds).toBeGreaterThan(trafficCameras.ttlSeconds);
  });

  it("has a terms record and a documented image origin for every wired provider", () => {
    for (const provider of CAMERA_PROVIDERS) {
      expect(provider.termsUrl).toMatch(/^https:\/\//);
      expect(provider.licence).not.toBe("");
      expect(provider.attribution).not.toBe("");
      expect(provider.stillImageOrigins.length).toBeGreaterThan(0);
    }
  });
});
