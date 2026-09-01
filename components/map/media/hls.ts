/**
 * Playing a genuinely live HLS stream in the reader's browser, directly from the operator.
 *
 * ## Why this file exists
 *
 * `<video src="…m3u8">` works on Safari and iOS, where HLS is implemented natively, and does
 * nothing whatsoever on Chrome and Firefox. It does not throw, it does not fire `error` in any
 * useful way, and it does not tell the reader anything: the player simply never starts. That
 * is the silent-failure shape this codebase has now met four times, and it is why `stream` is
 * a kind with code behind it rather than another element with a URL in it.
 *
 * ## The three rules
 *
 * 1. **Native first.** If the browser can play HLS itself, the library is never requested. It
 *    is detected by asking the element (`canPlayType`) rather than by reading the user-agent,
 *    which would be both unreliable and a fingerprinting read on an audience that objects to
 *    them.
 * 2. **The library is loaded at the moment a reader opens a stream, and never before.** That
 *    is what `HlsModuleLoader` is: an injected function returning a promise, called from an
 *    event handler. It exists as a parameter rather than a top-level `import` so that no
 *    route's initial bundle can ever contain it — a static import here would put a demuxer in
 *    the chunk of every page that renders a feature panel.
 * 3. **Every failure is reported.** A library that will not load, a browser without Media
 *    Source Extensions, and a fatal error mid-stream are three different sentences to the
 *    reader, and all three end with the same offer: open it at the operator's own page. The
 *    in-page player is an enhancement; the link out always works.
 *
 * ## Content-Security-Policy — read this before wondering why it works locally
 *
 * Native HLS is *media loading*, governed by `media-src`, which is already `'self' https:`.
 * hls.js fetches the manifest and every segment over **XHR/fetch**, which is `connect-src`,
 * and it feeds them to the element through a `blob:` MediaSource URL, which is `media-src`
 * again. So the library path needs both `connect-src` for the stream's origin and `blob:` in
 * `media-src`, and today's policy grants neither. Development has no CSP at all, so this is
 * invisible until production — exactly the class of defect ADR 0017 exists to prevent. The
 * needed directives are recorded in `docs/frontend/HANDOFF-map.md` §2.3; `infra/csp.caddy` is
 * generated and must not be hand-edited.
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
 * What the loader is expected to resolve to — but typed `unknown`, on purpose.
 *
 * A dynamic import of a third-party package is an external boundary like an HTTP response,
 * and the conventions §4 says those are narrowed rather than asserted. Typing the loader as
 * `Promise<HlsModule>` would be a claim about a package this repository does not yet depend
 * on, checked by nothing. `narrowHlsModule` checks it at runtime instead, so a major-version
 * change that moves `Events` or drops `isSupported` degrades to a link-out with a sentence
 * rather than throwing inside a click handler.
 */
export type HlsModuleLoader = () => Promise<unknown>;

/**
 * THE ONE LINE THAT CHANGES WHEN `hls.js` IS ADDED TO `package.json`.
 *
 * It becomes:
 *
 * ```ts
 * const loadHlsModule: HlsModuleLoader = () => import("hls.js");
 * ```
 *
 * and nothing else in this repository moves. A dynamic `import()` inside a function that is
 * only ever called from a click handler is what keeps the demuxer out of every route's
 * initial bundle; writing it as a static import at the top of this file would undo that
 * silently, because nothing in the type system distinguishes the two.
 *
 * Until the dependency lands, Safari and iOS play HLS natively (they never reach this) and
 * every other browser gets the honest "we cannot play this here — open it at the operator"
 * state, which is a state the panel renders and this suite tests. It is not a stub standing in
 * for behaviour: it is the documented degradation, and it is the same one a reader on a
 * browser without Media Source Extensions will always get.
 */
const loadHlsModule: HlsModuleLoader = () => import("hls.js");

/** Both MIME spellings a browser might answer to. Safari uses the first; older engines the second. */
const HLS_MIME_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegURL"] as const;

/**
 * Whether this browser plays HLS without help, asked of the element rather than the UA string.
 *
 * `canPlayType` returns `""`, `"maybe"` or `"probably"`. Anything other than `""` means the
 * engine will try, which is the whole question.
 */
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
       * `player-unavailable` — the library did not load, or is not what we expected. Ours.
       * `unsupported-browser` — the library loaded and says this engine cannot do it. Theirs.
       * The distinction matters because it sends the reader to a different remedy.
       */
      readonly reason: "player-unavailable" | "unsupported-browser";
    };

export interface HlsAttachOptions {
  /**
   * Called once, when the stream fails in a way it cannot recover from — a manifest the
   * network refused, a CSP block, a segment that will not decode. The instance is destroyed
   * before this fires, so the caller only has to render the sentence.
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
    /* A failed chunk fetch is a normal outcome on a bad connection, not an exception to raise. */
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
    // Stop first, then tell the caller. A destroyed instance cannot keep retrying against an
    // origin the reader has now been told we could not reach.
    detach();
    options.onFatalError(data.details ?? "the stream stopped");
  });

  instance.loadSource(url);
  instance.attachMedia(media);

  return { mode: "library", detach };
}
