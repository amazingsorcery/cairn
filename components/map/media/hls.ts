/**
 * Plays a live HLS stream in the browser, directly from the operator.
 *
 * `<video src=".m3u8">` works natively on Safari/iOS but silently does nothing on Chrome and
 * Firefox, so:
 * 1. Native first, detected via `canPlayType` (no UA sniffing). The library isn't loaded.
 * 2. Otherwise hls.js is loaded only when a stream is opened, via an injected loader, so it
 *    stays out of every route's initial bundle.
 * 3. Every failure is reported, and the panel always offers a link to the operator's page.
 *
 * CSP: hls.js fetches over XHR (`connect-src` for the stream origin) and plays through a
 * `blob:` MediaSource URL (`blob:` in `media-src`). Dev has no CSP, so a missing directive
 * only shows up in production. `infra/csp.caddy` is generated; don't hand-edit it.
 */

/** The subset of an hls.js error payload this module reads. */
export interface HlsErrorData {
  readonly fatal?: boolean;
  readonly details?: string;
}

/** The subset of an hls.js instance this module uses. */
export interface HlsInstanceLike {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  on(event: string, listener: (event: string, data: HlsErrorData) => void): void;
  destroy(): void;
}

/** The subset of the hls.js default export this module uses. */
export interface HlsConstructorLike {
  new (): HlsInstanceLike;
  isSupported(): boolean;
  readonly Events: { readonly ERROR: string };
}

/**
 * Resolves to the hls.js module, typed `unknown`: the result is checked at runtime by
 * `narrowHlsModule`, so an incompatible version degrades to a link-out instead of throwing.
 */
export type HlsModuleLoader = () => Promise<unknown>;

/**
 * Must stay a dynamic `import()` called from a click handler; a static import would put the
 * demuxer in every route's initial bundle.
 */
const loadHlsModule: HlsModuleLoader = () => import("hls.js");

/** Both MIME spellings a browser might answer to. Safari uses the first; older engines the second. */
const HLS_MIME_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegURL"] as const;

/** Whether this browser plays HLS natively. Any `canPlayType` answer other than `""` counts. */
export function browserPlaysHlsNatively(media: HTMLMediaElement): boolean {
  return HLS_MIME_TYPES.some((type) => media.canPlayType(type) !== "");
}

/** Whether the value the loader resolved to is really the library, and the constructor if so. */
export function narrowHlsModule(value: unknown): HlsConstructorLike | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as { default?: unknown }).default;
  if (typeof candidate !== "function") return null;

  const constructor = candidate as Partial<HlsConstructorLike>;
  if (typeof constructor.isSupported !== "function") return null;
  if (typeof constructor.Events?.ERROR !== "string") return null;

  return candidate as HlsConstructorLike;
}

/** How the stream ended up being played, or why it could not be. */
export type HlsAttachResult =
  | { readonly mode: "native" }
  /** `detach` destroys the library instance, which is what actually stops the fetching. */
  | { readonly mode: "library"; readonly detach: () => void }
  | {
      readonly mode: "unavailable";
      /**
       * `player-unavailable`: the library didn't load or isn't what we expected.
       * `unsupported-browser`: the library loaded but this browser can't use it.
       */
      readonly reason: "player-unavailable" | "unsupported-browser";
    };

export interface HlsAttachOptions {
  /**
   * Called once on an unrecoverable error (refused manifest, CSP block, undecodable segment).
   * The instance is already destroyed when this fires.
   */
  readonly onFatalError: (details: string) => void;
  /** Injected in tests, and the seam the real `import("hls.js")` goes through in production. */
  readonly loader?: HlsModuleLoader;
}

/**
 * Point a media element at a live HLS manifest, natively if possible and through the library
 * otherwise. Never calls `play()`: the reader does that, from the element's own controls.
 */
export async function attachHlsStream(
  media: HTMLMediaElement,
  url: string,
  options: HlsAttachOptions,
): Promise<HlsAttachResult> {
  if (browserPlaysHlsNatively(media)) {
    // The operator's own URL on the element. No library, no MediaSource, no blob.
    media.src = url;
    return { mode: "native" };
  }

  let resolved: unknown;
  try {
    resolved = await (options.loader ?? loadHlsModule)();
  } catch {
    /* A failed chunk fetch is expected on bad connections. */
    return { mode: "unavailable", reason: "player-unavailable" };
  }

  const Hls = narrowHlsModule(resolved);
  if (Hls === null) return { mode: "unavailable", reason: "player-unavailable" };
  if (!Hls.isSupported()) return { mode: "unavailable", reason: "unsupported-browser" };

  const instance = new Hls();
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    instance.destroy();
  };

  instance.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal !== true) return;
    // Destroy first so it stops retrying, then notify.
    detach();
    options.onFatalError(data.details ?? "the stream stopped");
  });

  instance.loadSource(url);
  instance.attachMedia(media);

  return { mode: "library", detach };
}
