import { fail, ok, type ToolResult } from "./result";

/**
 * Reverse image search launchers.
 *
 * This is the one tool in the workbench that **hands your image to somebody else**, and the
 * page says so at the top rather than in a footnote. Nothing is uploaded to this site — the
 * links below open the search engines directly, and the file or URL goes from your browser
 * to theirs. That is still a disclosure: whoever you are investigating is not the only party
 * who now knows the picture exists.
 *
 * The two modes exist because the engines support two different things:
 *
 *   - **By URL.** All four take an image URL as a query parameter, so one click opens all
 *     four result pages. The engine fetches the image from that URL itself, which means the
 *     host of the image sees a request from the engine — and, if it is a site the subject
 *     controls, learns that somebody is running the picture.
 *   - **By file.** No engine accepts a file through a link, so the launcher opens each
 *     engine's own upload page and the reader drops the file in. That is less magical and it
 *     is the only honest option: a page that appeared to submit the file for you would have
 *     to send it through a server, and this one does not have one.
 */

export interface SearchEngine {
  readonly id: string;
  readonly name: string;
  /** Operator and the jurisdiction its data sits in, because for this audience that matters. */
  readonly operator: string;
  /** Template for a search by image URL. The URL is appended, percent-encoded. */
  readonly byUrlPrefix: string;
  /** The engine's own page for searching by uploaded file. */
  readonly uploadPage: string;
  /** What this engine is actually good at, so a reader can pick rather than open all four. */
  readonly strength: string;
}

/**
 * All four URL templates were checked against the engines' documented and widely published
 * forms while this tool was written. They are query-string entry points, not APIs: an engine
 * can change one without notice, and if a link stops producing results that is the first
 * thing to check.
 */
export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: "google-lens",
    name: "Google Lens",
    operator: "Google LLC, United States",
    byUrlPrefix: "https://lens.google.com/uploadbyurl?url=",
    uploadPage: "https://lens.google.com/",
    strength:
      "Best at recognising places, landmarks, products and text in the frame, and it will translate signage. Weakest at finding other copies of the same photograph.",
  },
  {
    id: "yandex",
    name: "Yandex Images",
    operator: "Yandex, Russia and the Netherlands",
    byUrlPrefix: "https://yandex.com/images/search?rpt=imageview&url=",
    uploadPage: "https://yandex.com/images/",
    strength:
      "Consistently the strongest at finding near-duplicates and at faces and buildings in eastern Europe and central Asia, where the others have thin coverage. Consider its jurisdiction before sending it a sensitive image.",
  },
  {
    id: "bing",
    name: "Bing Visual Search",
    operator: "Microsoft Corporation, United States",
    byUrlPrefix: "https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:",
    uploadPage: "https://www.bing.com/visualsearch",
    strength:
      "Good at cropped regions — it will search part of an image — and often surfaces stock and commercial sources the others miss.",
  },
  {
    id: "tineye",
    name: "TinEye",
    operator: "TinEye (Idée Inc.), Canada",
    byUrlPrefix: "https://tineye.com/search?url=",
    uploadPage: "https://tineye.com/",
    strength:
      "The only one that sorts by oldest first, which is what you want when the question is where a picture appeared *first*. It matches exact and modified copies, not similar scenes.",
  },
];

/**
 * Build the search URL for one engine.
 *
 * Rejects anything that is not an absolute `http` or `https` URL. A `javascript:` or `data:`
 * value here would be handed straight to `window.open`, and a relative path would silently
 * produce a search for a URL that does not exist.
 */
export function buildSearchUrl(engine: SearchEngine, imageUrl: string): ToolResult<string> {
  const trimmed = imageUrl.trim();
  if (trimmed.length === 0) return fail("Paste the address of an image first.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail("That is not a complete web address. It needs to start with https://.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fail(
      `A ${parsed.protocol.replace(":", "")} address cannot be searched: the engine has to be able to fetch the image over the web.`,
    );
  }
  return ok(`${engine.byUrlPrefix}${encodeURIComponent(parsed.toString())}`);
}

/** Every engine's URL for one image, or the reason a particular one could not be built. */
export function buildAllSearchUrls(
  imageUrl: string,
): readonly { readonly engine: SearchEngine; readonly url: string | null; readonly error: string | null }[] {
  return SEARCH_ENGINES.map((engine) => {
    const built = buildSearchUrl(engine, imageUrl);
    return {
      engine,
      url: built.ok ? built.value : null,
      error: built.ok ? null : built.error,
    };
  });
}

/**
 * What to do when the reverse search finds nothing, which is the usual outcome.
 *
 * Written here rather than in the page so it stays next to the engine list it describes: if
 * an engine is added or removed, the advice about what its silence means moves with it.
 */
export const NEGATIVE_RESULT_GUIDANCE = [
  "A reverse image search finds published copies. Silence from all four means the picture has not been indexed — not that it is original, and not that it is authentic. Most images taken by most people have never been indexed by anything.",
  "Indexing is slow and partial. A photograph posted an hour ago, posted inside a closed group, or posted on a platform that blocks crawlers will not be found however many engines you try.",
  "Crop and search again. Engines match whole frames; a distinctive building, sign or vehicle in the corner is often findable when the full image is not.",
  "Try a horizontally flipped copy. Mirroring is the standard way to evade matching and it costs one more search to defeat.",
  "For video, pull keyframes and search those. There is no video-native reverse search worth the name.",
] as const;
