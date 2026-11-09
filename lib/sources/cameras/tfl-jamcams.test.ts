import { describe, expect, it } from "vitest";

import { CAMERA_STILL_IMAGE_ORIGINS } from "./origins";
import { toCameraFeature } from "./provider";
import { tflJamCams } from "./tfl-jamcams";

/**
 * Real payload: 26 places captured unedited from `https://api.tfl.gov.uk/Place/Type/JamCam`
 * on 2026-09-01 (22 available, 4 not). Note `available` is the string "false", not a boolean.
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
    // Every captured place has position and media, so none should be filtered.
    expect(records).toHaveLength(fixture.length);
  });

  it("keeps the cameras TfL marks unavailable, flagged rather than hidden", () => {
    const { records } = read();
    const unavailable = records.filter((record) => !record.available);
    // 4 of the 26 captured; 88 of 890 in the full catalogue on the capture date.
    expect(unavailable).toHaveLength(4);
    expect(unavailable.length).toBeLessThan(records.length);
    // Still have media, so they're kept.
    for (const record of unavailable) expect(record.media.still).not.toBeNull();
  });

  it("separates the still from the video, and calls neither a live stream", () => {
    const { records } = read();
    for (const record of records) {
      expect(record.media.still?.url).toMatch(/^https:\/\/.+\.jpg$/);
      expect(record.media.video?.url).toMatch(/^https:\/\/.+\.mp4$/);
      expect(record.media.video?.format).toBe("mp4");
      // The MP4 is a rewritten file, not a live stream.
      expect(record.media.stream).toBeNull();
    }
  });

  it("carries TfL's documented still cadence and refuses to invent one for the video", () => {
    const { records } = read();
    for (const record of records) {
      // TfL's documented still refresh.
      expect(record.media.still?.refreshSeconds).toBe(180);
      // Undocumented for video.
      expect(record.media.video?.refreshSeconds).toBeNull();
    }
  });

  it("uses TfL's own view text as what the camera looks at", () => {
    const { records } = read();
    const first = records[0];
    expect(first).toBeDefined();
    expect(first?.subject).not.toBe("");
    // Real records carry a compass-and-junction description.
    expect(records.some((record) => /[A-Za-z]{3,}/.test(record.subject))).toBe(true);
  });

  it("puts every still on an origin the CSP allowlist names", () => {
    // A host missing from `img-src` only fails in production (no CSP in dev).
    const { records } = read();
    for (const record of records) {
      const still = record.media.still;
      expect(still).not.toBeNull();
      if (!still) continue;
      expect(CAMERA_STILL_IMAGE_ORIGINS).toContain(new URL(still.url).origin);
    }
  });

  it("never points a media URL at our own server", () => {
    // Media must stay on the operator's host; we never relay it.
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
    // Never upstream values.
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
