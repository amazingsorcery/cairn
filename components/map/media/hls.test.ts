import { describe, expect, it, vi } from "vitest";

import { attachHlsStream, browserPlaysHlsNatively, narrowHlsModule } from "./hls";

/**
 * HLS playback. Chrome/Firefox fail silently on `<video src=".m3u8">`, so:
 * 1. Use native HLS where available and never load the library.
 * 2. Load the library only when a stream is opened (injected loader).
 * 3. Report every failure (library load, no MSE, fatal stream error).
 *
 * The fake matches the hls.js surface that `narrowHlsModule` checks at runtime.
 */

interface FakeHlsRecord {
  readonly loaded: string[];
  readonly attached: HTMLMediaElement[];
  destroyed: number;
  fire: ((data: { fatal?: boolean; details?: string }) => void) | null;
}

function fakeHlsModule(options: { supported?: boolean } = {}) {
  const record: FakeHlsRecord = { loaded: [], attached: [], destroyed: 0, fire: null };

  class FakeHls {
    static isSupported() {
      return options.supported ?? true;
    }
    static readonly Events = { ERROR: "hlsError" } as const;

    loadSource(url: string) {
      record.loaded.push(url);
    }
    attachMedia(media: HTMLMediaElement) {
      record.attached.push(media);
    }
    on(event: string, listener: (event: string, data: { fatal?: boolean }) => void) {
      if (event === "hlsError") record.fire = (data) => listener(event, data);
    }
    destroy() {
      record.destroyed += 1;
    }
  }

  return { module: { default: FakeHls }, record };
}

function videoElement(canPlay = ""): HTMLMediaElement {
  const element = document.createElement("video");
  // jsdom's canPlayType always returns "" (like Chrome/Firefox); override to test Safari.
  Object.defineProperty(element, "canPlayType", { value: () => canPlay, configurable: true });
  return element;
}

describe("native HLS", () => {
  it("is detected from the element itself, not from a user-agent string", () => {
    // No UA sniffing: unreliable, and a fingerprinting read.
    expect(browserPlaysHlsNatively(videoElement("maybe"))).toBe(true);
    expect(browserPlaysHlsNatively(videoElement("probably"))).toBe(true);
    expect(browserPlaysHlsNatively(videoElement(""))).toBe(false);
  });

  it("plays through the browser and never asks for the library", async () => {
    const loader = vi.fn();
    const element = videoElement("maybe");
    const result = await attachHlsStream(element, "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader,
    });

    expect(result.mode).toBe("native");
    expect(element.getAttribute("src")).toBe("https://example.org/live.m3u8");
    // No library fetch on browsers that don't need it.
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("the library path, for browsers without native HLS", () => {
  it("loads the library only when asked, then hands it the operator's own URL", async () => {
    const { module, record } = fakeHlsModule();
    const loader = vi.fn().mockResolvedValue(module);
    const element = videoElement();

    const result = await attachHlsStream(element, "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe("library");
    expect(record.loaded).toEqual(["https://example.org/live.m3u8"]);
    expect(record.attached).toEqual([element]);
    // The browser talks to the operator directly, never via our origin.
    expect(element.getAttribute("src")).toBeNull();
  });

  it("never starts playback by itself", async () => {
    const { module } = fakeHlsModule();
    const element = videoElement();
    const play = vi.fn();
    Object.defineProperty(element, "play", { value: play, configurable: true });

    await attachHlsStream(element, "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.resolve(module),
    });

    // No autoplay; the reader presses play.
    expect(play).not.toHaveBeenCalled();
  });

  it("destroys the instance on detach, which is what actually ends the connection", async () => {
    const { module, record } = fakeHlsModule();
    const result = await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.resolve(module),
    });

    if (result.mode !== "library") throw new Error("expected the library path");
    result.detach();
    expect(record.destroyed).toBe(1);
    // Idempotent: the panel may unmount and clean up in either order.
    result.detach();
    expect(record.destroyed).toBe(1);
  });

  it("reports a fatal stream error to the caller and stops", async () => {
    const { module, record } = fakeHlsModule();
    const onFatalError = vi.fn();
    await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError,
      loader: () => Promise.resolve(module),
    });

    record.fire?.({ fatal: false, details: "a recoverable hiccup" });
    expect(onFatalError).not.toHaveBeenCalled();

    record.fire?.({ fatal: true, details: "manifestLoadError" });
    expect(onFatalError).toHaveBeenCalledTimes(1);
    // e.g. a manifest blocked by connect-src; the panel then links out.
    expect(record.destroyed).toBe(1);
  });
});

describe("when the stream cannot be played here at all", () => {
  it("says the player is unavailable when the library will not load", async () => {
    const result = await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.reject(new Error("chunk load failed")),
    });
    expect(result).toEqual({ mode: "unavailable", reason: "player-unavailable" });
  });

  it("says the same when the loader resolves to something that is not the library", async () => {
    // The dynamic import result is narrowed, so a changed export shape doesn't throw.
    const result = await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.resolve({ notTheLibrary: true }),
    });
    expect(result).toEqual({ mode: "unavailable", reason: "player-unavailable" });
  });

  it("distinguishes a browser without Media Source Extensions from a missing library", async () => {
    // Different message: ours to fix vs. the reader's browser.
    const { module } = fakeHlsModule({ supported: false });
    const result = await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.resolve(module),
    });
    expect(result).toEqual({ mode: "unavailable", reason: "unsupported-browser" });
  });
});

describe("narrowing what the dynamic import returned", () => {
  it("accepts the documented hls.js shape and rejects everything else", () => {
    const { module } = fakeHlsModule();
    expect(narrowHlsModule(module)).not.toBeNull();

    expect(narrowHlsModule(null)).toBeNull();
    expect(narrowHlsModule(undefined)).toBeNull();
    expect(narrowHlsModule({})).toBeNull();
    expect(narrowHlsModule({ default: {} })).toBeNull();
    // No static isSupported: a different library or major version.
    expect(narrowHlsModule({ default: class {}, Events: { ERROR: "e" } })).toBeNull();
  });
});
