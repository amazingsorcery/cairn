import { describe, expect, it } from "vitest";

import { CAMERA_STILL_IMAGE_ORIGINS } from "./origins";
import { toCameraFeature } from "./provider";
import { tflJamCams } from "./tfl-jamcams";

/**
 * REAL PAYLOAD, NOT AN INVENTED ONE.
 *
 * 26 places captured verbatim from `https://api.tfl.gov.uk/Place/Type/JamCam` on 2026-09-01
 * — 22 that TfL reports available and 4 it reports unavailable, out of 890 in the full
 * response. Nothing is edited: `$type`, `children`, `childrenUrls` and the escaped slashes in
 * the `view` text are all as TfL sent them.
 *
 * The discipline matters. `alt_baro: "ground"` on a quarter of a real aircraft response is
 * the kind of thing no invented fixture contains, and `available: "false"` — a *string*
 * "false", on 10% of this catalogue — is this feed's version of it.
 */
import fixture from "../__fixtures__/tfl-jamcams.json";

const READ_AT = new Date("2026-09-01T16:52:00Z");

function read() {
  const result = tflJamCams.read(fixture, READ_AT);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
}

describe("tfl-jamcams", () => {
  it("maps the captured catalogue in full, with nothing dropped", () => {
    const { records } = read();
    // Every place in the capture carries lat, lon, imageUrl and videoUrl, so every one of
    // them is a camera. A count below the fixture length means something is being silently
    // filtered, which is the failure this layer keeps meeting.
    expect(records).toHaveLength(fixture.length);
  });

  it("keeps the cameras TfL marks unavailable, flagged rather than hidden", () => {
    const { records } = read();
    const unavailable = records.filter((record) => !record.available);
    // 4 of the 26 captured; 88 of 890 in the full catalogue on the capture date.
    expect(unavailable).toHaveLength(4);
    expect(unavailable.length).toBeLessThan(records.length);
    // They still have media — TfL's images resolve for these — so hiding them would be a
    // count that quietly disagrees with the operator's own catalogue.
    for (const record of unavailable) expect(record.media.still).not.toBeNull();
  });

  it("separates the still from the video, and calls neither a live stream", () => {
    const { records } = read();
    for (const record of records) {
      expect(record.media.still?.url).toMatch(/^https:\/\/.+\.jpg$/);
      expect(record.media.video?.url).toMatch(/^https:\/\/.+\.mp4$/);
      expect(record.media.video?.format).toBe("mp4");
      /*
       * THE DISTINCTION THAT MATTERS. TfL's MP4 is a file that gets rewritten, not a
       * manifest that extends. An investigator reading a timestamp needs those to be
       * different things, so `stream` stays null and `hasLiveStream` stays false.
       */
      expect(record.media.stream).toBeNull();
    }
  });

  it("carries TfL's documented still cadence and refuses to invent one for the video", () => {
    const { records } = read();
    for (const record of records) {
      // "refreshed every three minutes - sometimes more often" — TfL's number, read 2026-09-01.
      expect(record.media.still?.refreshSeconds).toBe(180);
      // TfL documents the stills and says nothing about the video. Null, not 180.
      expect(record.media.video?.refreshSeconds).toBeNull();
    }
  });

  it("uses TfL's own view text as what the camera looks at", () => {
    const { records } = read();
    const first = records[0];
    expect(first).toBeDefined();
    expect(first?.subject).not.toBe("");
    // At least one record in any real sample carries a compass-and-junction description
    // rather than a category, which is the whole reason this field is TfL's text.
    expect(records.some((record) => /[A-Za-z]{3,}/.test(record.subject))).toBe(true);
  });

  it("puts every still on an origin the CSP allowlist names", () => {
    // `img-src` is an allowlist. A host missing from it is invisible in development, where
    // no CSP is applied, and blocks every frame in production. ADR 0017.
    const { records } = read();
    for (const record of records) {
      const still = record.media.still;
      expect(still).not.toBeNull();
      if (!still) continue;
      expect(CAMERA_STILL_IMAGE_ORIGINS).toContain(new URL(still.url).origin);
    }
  });

  it("never points a media URL at our own server", () => {
    // Product-brief §2b. If one of these ever becomes a path on our origin, this product
    // has started rebroadcasting.
    const { records } = read();
    for (const record of records) {
      for (const url of [record.media.still?.url, record.media.video?.url]) {
        if (!url) continue;
        expect(url.startsWith("/")).toBe(false);
        expect(new URL(url).hostname).not.toBe("localhost");
      }
    }
  });

  it("links back to the operator's own record for the camera", () => {
    const { records } = read();
    for (const record of records) {
      expect(record.sourceUrl.startsWith("https://api.tfl.gov.uk/Place/")).toBe(true);
    }
  });

  it("reports the read time, because TfL publishes no catalogue timestamp", () => {
    expect(read().observedAt).toEqual(READ_AT);
  });

  it("disables itself, and only itself, when the payload changes shape", () => {
    const result = tflJamCams.read([{ id: "JamCams_1", commonName: "x" }], READ_AT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
    // The provider names itself, so an operator reading the log knows which upstream moved.
    expect(result.failure.message).toContain("tfl-jamcams");
    // Never the upstream's own values: they end up in a log line and on a screen.
    expect(result.failure.message).not.toContain("JamCams_1");
  });

  it("builds a feature whose media fields are all present, absent ones as null", () => {
    const { records } = read();
    const first = records[0];
    expect(first).toBeDefined();
    if (!first) return;
    const feature = toCameraFeature(tflJamCams, first, {
      lastVerifiedAt: "2026-09-01",
      confidence: "verified",
    });
    expect(feature).not.toBeNull();
    expect(feature?.properties.mediaForms).toBe("still,video");
    expect(feature?.properties.hasLiveStream).toBe(false);
    expect(feature?.properties.streamUrl).toBeNull();
    expect(feature?.properties.streamFormat).toBeNull();
    // Back-compatibility: `components/map/registry/cameras.ts` still reads `embedUrl`.
    expect(feature?.properties.embedUrl).toBe(feature?.properties.stillUrl);
    expect(feature?.properties.attribution).toContain("Powered by TfL Open Data");
  });
});
