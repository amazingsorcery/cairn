import { describe, expect, it, vi } from "vitest";

import { attachHlsStream, browserPlaysHlsNatively, narrowHlsModule } from "./hls";

/**
 * HLS is the one media kind that needs code rather than an element.
 *
 * Safari and iOS play an `.m3u8` natively from `<video src>`; Chrome and Firefox will not,
 * and — this is the part that matters — they fail *silently*. The element sits there, nothing
 * plays, and no error surfaces. Every silent failure in this codebase has been treated as a
 * defect rather than a limitation, so this module has three jobs and each of them is tested
 * here rather than described in a comment:
 *
 * 1. **Use the browser's own player where it exists** and never load a library at all. Roughly
 *    a fifth of this audience is on Safari or iOS and should pay nothing for a polyfill.
 * 2. **Load the library only at the moment a reader opens a stream**, never at import time —
 *    which is why the loader is an injected function returning a promise rather than a
 *    top-level `import`.
 * 3. **Fail out loud.** A library that will not load, a browser without Media Source
 *    Extensions, and a fatal error mid-stream all have to reach the panel, because the
 *    alternative is a play button that does nothing.
 *
 * The fake below matches hls.js's documented surface — default-exported class, static
 * `isSupported()`, `Events.ERROR`, `loadSource`, `attachMedia`, `on`, `destroy` — which is
 * also exactly the surface `narrowHlsModule` checks at runtime. The dependency is not
 * installed yet (the maintainer adds it); when it is, `narrowHlsModule` is what proves the
 * real module still has that shape rather than a type assertion claiming it does.
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
  // jsdom's canPlayType always returns "", which is the Chrome/Firefox answer. Overriding it
  // per element is how the Safari branch gets exercised at all.
  Object.defineProperty(element, "canPlayType", { value: () => canPlay, configurable: true });
  return element;
}

describe("native HLS", () => {
  it("is detected from the element itself, not from a user-agent string", () => {
    // Sniffing the UA would be wrong twice over: it is unreliable, and it is a fingerprinting
    // read on an audience that objects to those.
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
    // THE ASSERTION THIS TEST IS FOR. A polyfill fetched on a browser that does not need it
    // is bytes and a third-party request for nothing.
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
    // Never our origin. The reader's browser talks to the operator; product-brief §2b.
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

    // Autoplay is forbidden outright (ADR 0015) and moving pictures that start on their own
    // are also what `prefers-reduced-motion` is about. The reader presses play.
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
    // A manifest blocked by connect-src arrives here. The panel must say so and link out,
    // rather than leaving a player that will never start.
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
    // A dynamic import is an external boundary like any other, so its result is narrowed
    // rather than asserted. An upstream that changes its export shape must not throw here.
    const result = await attachHlsStream(videoElement(), "https://example.org/live.m3u8", {
      onFatalError: vi.fn(),
      loader: () => Promise.resolve({ notTheLibrary: true }),
    });
    expect(result).toEqual({ mode: "unavailable", reason: "player-unavailable" });
  });

  it("distinguishes a browser without Media Source Extensions from a missing library", async () => {
    // Different sentence for the reader: one is our deployment's problem, the other is their
    // browser's, and telling them the wrong one sends them to the wrong remedy.
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
    // A class with no static isSupported is a different library, or a different major version.
    expect(narrowHlsModule({ default: class {}, Events: { ERROR: "e" } })).toBeNull();
  });
});
