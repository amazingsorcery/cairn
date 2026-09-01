/**
 * What a URL's own path says it serves — the second half of `resolveMedia`'s honesty check.
 *
 * `LayerMedia` carries two claims a record can get wrong without anything noticing. The first
 * is `host`, which the reader is shown before deciding whether to reveal their address to a
 * third party, and which `resolveMedia` has always refused when it disagreed with the URL.
 * The second is `kind`, added when `video` and `stream` arrived, and it fails in exactly the
 * same quiet way:
 *
 * - an `<img>` whose `src` is an `.mp4` renders a broken-image glyph;
 * - an `<audio>` whose `src` is an `.m3u8` plays nothing at all outside Safari, silently;
 * - and a five-minute-old clip labelled "live" is not a rendering bug at all — it is the
 *   product telling an investigator something untrue about what they are looking at.
 *
 * So the extension is read and compared. **It is not a guess.** An unrecognised extension, an
 * absent one, or a URL that will not parse all return `null`, and the declared kind stands
 * unchallenged. This function only ever answers "that is definitely a different class of
 * thing"; it never answers "that is probably an image". Most stream endpoints are
 * extensionless and must keep working.
 *
 * DASH (`.mpd`) is deliberately absent. We have no DASH player, so classifying it would only
 * let a record claim a kind we cannot honour; leaving it unrecognised means a DASH URL is
 * refused by whatever element it is handed to and fails visibly rather than being blessed.
 */

/** The four classes a URL's own extension can establish. Mirrors `LayerMedia.kind`, less `link`. */
export type MediaUrlClass = "image" | "audio" | "video" | "stream";

/**
 * Extension to class. Only containers a browser can actually play or draw are listed: adding
 * one here is a claim that `<img>`, `<audio>` or `<video>` will accept it.
 */
const BY_EXTENSION: ReadonlyMap<string, MediaUrlClass> = new Map<string, MediaUrlClass>([
  [".jpg", "image"],
  [".jpeg", "image"],
  [".png", "image"],
  [".webp", "image"],
  [".gif", "image"],
  [".avif", "image"],
  [".bmp", "image"],

  [".mp3", "audio"],
  [".aac", "audio"],
  [".m4a", "audio"],
  [".ogg", "audio"],
  [".oga", "audio"],
  [".opus", "audio"],
  [".wav", "audio"],
  [".flac", "audio"],

  [".mp4", "video"],
  [".m4v", "video"],
  [".webm", "video"],
  [".mov", "video"],
  [".ogv", "video"],

  /*
   * HLS, and only HLS. `.m3u` is an ordinary playlist file — a list of URLs — and calling one
   * a live stream would be precisely the mislabelling this module exists to catch.
   */
  [".m3u8", "stream"],
]);

/**
 * The class a URL's path establishes, or `null` when it establishes nothing.
 *
 * The query string is ignored on purpose: camera URLs are routinely cache-busted with a
 * timestamp, and reading the whole URL would classify almost nothing.
 */
export function mediaClassFromUrl(url: string): MediaUrlClass | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const file = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  const dot = file.lastIndexOf(".");
  // `dot <= 0` covers both "no extension" and a leading-dot filename, which has none either.
  if (dot <= 0) return null;

  return BY_EXTENSION.get(file.slice(dot)) ?? null;
}
