import { describe, expect, it } from "vitest";

import fintrafficRegistry from "@/content/cameras/fintraffic-digitraffic.json";
import tflRegistry from "@/content/cameras/transport-for-london.json";
import radioFixture from "@/lib/sources/__fixtures__/radio-browser.json";
import tflFixture from "@/lib/sources/__fixtures__/tfl-jamcams.json";
import { radioBrowser } from "@/lib/sources/radio-browser";
import { mediaClassFromUrl } from "./media-kind";

/**
 * WHY A URL CLASSIFIER EXISTS AT ALL.
 *
 * `LayerMedia.kind` is a claim about what the reader is about to be shown: a still, a file, or
 * a genuinely live stream. Until now the only claim a record could get wrong was its `host`,
 * and `resolveMedia` already refuses that. `kind` is the second one, and it fails in the same
 * quiet way — an `<img>` pointed at an `.mp4` renders a broken-image glyph, an `<audio>`
 * pointed at an `.m3u8` plays nothing at all outside Safari and reports nothing anywhere.
 *
 * So the extension is read and compared. It is deliberately NOT a guess: an unrecognised or
 * absent extension returns `null` and the declared kind stands. The function only ever says
 * "this is definitely a different class of thing", never "this is probably".
 */

describe("classifying a media URL by what the operator actually serves", () => {
  it("reads the extension out of the path and ignores the query string", () => {
    // Camera URLs are routinely cache-busted. Reading the whole URL would classify nothing.
    expect(mediaClassFromUrl("https://example.org/cam/01.jpg?t=1756684800")).toBe("image");
    expect(mediaClassFromUrl("https://example.org/cam/01.mp4#t=0")).toBe("video");
  });

  it("is case-insensitive, because operators are inconsistent about it", () => {
    expect(mediaClassFromUrl("https://example.org/CAM/01.JPG")).toBe("image");
    expect(mediaClassFromUrl("https://example.org/CAM/01.MP4")).toBe("video");
  });

  it("says nothing about a URL with no extension it recognises", () => {
    // A great many stream endpoints are extensionless, and a great many are DASH or a
    // proprietary path. Returning a class here would invent a fact.
    expect(mediaClassFromUrl("https://stream.example.org/live")).toBeNull();
    expect(mediaClassFromUrl("https://stream.example.org/manifest.mpd")).toBeNull();
    expect(mediaClassFromUrl("https://example.org/")).toBeNull();
    expect(mediaClassFromUrl("not a url at all")).toBeNull();
  });

  it("does not treat a dotfile as an extension", () => {
    expect(mediaClassFromUrl("https://example.org/.htaccess")).toBeNull();
  });

  it("separates a live HLS manifest from a plain playlist", () => {
    expect(mediaClassFromUrl("https://example.org/live/master.m3u8")).toBe("stream");
    // `.m3u` is an ordinary playlist file, not HLS. Calling it a live stream would be the
    // exact mislabelling this whole change exists to prevent.
    expect(mediaClassFromUrl("https://example.org/list.m3u")).toBeNull();
  });
});

/**
 * THE COMMITTED CONTENT AND THE CAPTURED UPSTREAMS, not invented strings. If TfL ever
 * republishes its JamCams under a different container, or the camera registry starts carrying
 * clips, this is where it is noticed.
 */
describe("what the real sources actually publish", () => {
  it("classifies every committed camera embed URL as something we can render", () => {
    const files = [tflRegistry, fintrafficRegistry];
    const urls = files.flatMap((file) =>
      file.cameras
        .map((camera) => camera.embedUrl)
        .filter((url): url is string => typeof url === "string"),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const media = mediaClassFromUrl(url);
      expect(["image", "video", "stream"], url).toContain(media);
    }
  });

  it("recognises the MP4 clip TfL publishes beside every JamCam still", () => {
    /*
     * The captured Unified API payload carries `imageUrl` AND `videoUrl` per camera, on the
     * same S3 origin. That is why `video` is a kind rather than a hypothetical: the moment
     * `content/cameras/` records the clip URL, the panel must play it rather than render a
     * broken image, and it must not call a periodically-replaced file "live".
     *
     * Read through a narrowing rather than the JSON module's inferred type, because that
     * inference is a structural accident of whichever places happened to be captured.
     */
    const videoUrls = jamCamProperty(tflFixture, "videoUrl");
    const imageUrls = jamCamProperty(tflFixture, "imageUrl");

    expect(videoUrls.length).toBeGreaterThan(0);
    expect(imageUrls.length).toBeGreaterThan(0);
    for (const url of videoUrls) expect(mediaClassFromUrl(url), url).toBe("video");
    for (const url of imageUrls) expect(mediaClassFromUrl(url), url).toBe("image");
  });

  it("recognises the HLS manifests the radio catalogue already carries", () => {
    /*
     * Not hypothetical either: the captured Radio Browser page contains stations whose
     * resolved stream URL is an `.m3u8`, and an <audio> element cannot play one outside
     * Safari — it fails silently, which is the failure mode this codebase keeps meeting.
     * Read through the adapter's own `normalise` so a property rename fails here too.
     */
    const stations = radioBrowser.normalise(radioFixture, {});
    const hls = stations.filter((station) => station.properties.isHls === true);
    expect(hls.length).toBeGreaterThan(0);
    for (const station of hls) {
      expect(mediaClassFromUrl(String(station.properties.streamUrl)), station.id).toBe("stream");
    }
  });
});

/** Every `additionalProperties` value under one key, across the captured JamCam places. */
function jamCamProperty(payload: unknown, key: string): readonly string[] {
  const values: string[] = [];
  if (!Array.isArray(payload)) return values;
  for (const place of payload) {
    if (typeof place !== "object" || place === null) continue;
    const extras = (place as { additionalProperties?: unknown }).additionalProperties;
    if (!Array.isArray(extras)) continue;
    for (const extra of extras) {
      if (typeof extra !== "object" || extra === null) continue;
      const record = extra as { key?: unknown; value?: unknown };
      if (record.key === key && typeof record.value === "string") values.push(record.value);
    }
  }
  return values;
}
