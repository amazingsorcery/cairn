import { describe, expect, it } from "vitest";

import type { SourceFeature } from "@/lib/sources/types";
import { resolveMedia } from "./index";
import { camerasLayer } from "./cameras";
import type { LayerMedia, MapLayerDefinition } from "./types";

/**
 * `resolveMedia` is the only thing standing between a registry entry's claim and a reader's
 * browser, and every check in it is about a claim that would otherwise be false in a way
 * nothing visible would reveal.
 *
 * The host check was there from the start. The kind check arrived with `video` and `stream`,
 * and it exists because "this is live" is now something a record can assert. A clip the
 * operator replaces every few minutes, presented as live, is not a rendering bug — it is the
 * product telling an investigator something untrue about what they are looking at, which is
 * the one failure this build has refused six times.
 */

/** A layer that returns exactly the record under test, so nothing else is in the way. */
function layerReturning(media: LayerMedia | null): MapLayerDefinition {
  return { ...camerasLayer, media: () => media };
}

const feature: SourceFeature = {
  id: "probe-1",
  kind: "cameras",
  latitude: 51.5,
  longitude: -0.13,
  label: "Probe",
  properties: {},
};

function resolve(media: LayerMedia | null): LayerMedia | null {
  return resolveMedia(layerReturning(media), feature);
}

const base = {
  host: "example.org",
  disclosure: "Opening this connects your browser directly to example.org.",
  credit: null,
} as const;

describe("what resolveMedia lets through", () => {
  it("passes a video file whose URL is a video file", () => {
    const media = resolve({
      ...base,
      kind: "video",
      url: "https://example.org/cam.mp4",
      refreshNote: null,
    });
    expect(media?.kind).toBe("video");
  });

  it("passes an HLS stream whose URL is an HLS manifest", () => {
    const media = resolve({
      ...base,
      kind: "stream",
      url: "https://example.org/live/master.m3u8",
      medium: "video",
    });
    expect(media?.kind).toBe("stream");
  });

  it("passes a URL whose path establishes nothing, leaving the declared kind to stand", () => {
    // Extensionless endpoints are the norm for streams. Refusing them would refuse most of
    // the real world on the strength of a filename convention.
    const media = resolve({ ...base, kind: "stream", url: "https://example.org/live", medium: "audio" });
    expect(media?.kind).toBe("stream");
  });
});

describe("what resolveMedia refuses, and why each one matters", () => {
  it("refuses an image whose URL is a video", () => {
    // An <img> pointed at an .mp4 renders a broken-image glyph and nothing else.
    expect(resolve({ ...base, kind: "image", url: "https://example.org/cam.mp4" })).toBeNull();
  });

  it("refuses audio whose URL is an HLS manifest", () => {
    // Outside Safari this plays nothing at all and reports nothing at all.
    expect(resolve({ ...base, kind: "audio", url: "https://example.org/live.m3u8" })).toBeNull();
  });

  it("refuses a clip that calls itself a live stream", () => {
    // THE ASSERTION THIS FILE IS FOR. `stream` means segments keep arriving; an .mp4 does not.
    expect(
      resolve({ ...base, kind: "stream", url: "https://example.org/cam.mp4", medium: "video" }),
    ).toBeNull();
  });

  it("refuses a live stream that calls itself a clip", () => {
    // The other direction is just as wrong: a reader told a manifest is a stored file may
    // conclude a live picture is historical.
    expect(
      resolve({
        ...base,
        kind: "video",
        url: "https://example.org/live.m3u8",
        refreshNote: null,
      }),
    ).toBeNull();
  });

  it("still refuses a record whose host disagrees with its own URL", () => {
    expect(
      resolve({
        ...base,
        host: "cdn.example.net",
        kind: "video",
        url: "https://example.org/cam.mp4",
        refreshNote: null,
      }),
    ).toBeNull();
  });

  it("still refuses plain http for anything embedded, and allows it for a link", () => {
    expect(
      resolve({ ...base, kind: "video", url: "http://example.org/cam.mp4", refreshNote: null }),
    ).toBeNull();
    expect(resolve({ ...base, kind: "link", url: "http://example.org/cam.mp4" })?.kind).toBe(
      "link",
    );
  });

  it("exempts a link from the kind check, because a link may point at anything", () => {
    // A link out to an HLS manifest is the correct treatment for a host we cannot allow-list.
    // It is a navigation, not an element, so nothing about it can silently fail to render.
    expect(
      resolve({ ...base, kind: "link", url: "https://example.org/live/master.m3u8" })?.kind,
    ).toBe("link");
  });
});
