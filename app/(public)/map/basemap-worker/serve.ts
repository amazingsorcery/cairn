import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Serves MapLibre's web worker from our own origin.
 *
 * ## The bug this exists to fix, because it is invisible until you look for it
 *
 * `maplibre-gl@6` locates its worker at runtime with
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Under a bundler that is a
 * **dynamic** template expression, so webpack cannot see it and does not emit the file — and
 * `import.meta.url` has by then been rewritten to a `/_next/static/chunks/…` URL. MapLibre
 * therefore asks the app for a chunk that was never built, Next answers with its HTML 404
 * page, and the browser refuses it: *"Failed to load module script: the server responded with
 * a non-JavaScript MIME type of text/html."*
 *
 * The failure mode is why this needed finding rather than debugging. deck.gl draws on its own
 * canvas, so the data layers appear perfectly. MapLibre parses vector tiles **in the worker**,
 * so with no worker it never even requests a tile: no network error, no exception, no missing
 * image. Just a black rectangle with correct dots on it, which looks like a styling problem
 * and is not one.
 *
 * ## Two literal routes, not one `[file]` route
 *
 * `maplibre-gl-worker.mjs` does `import "./maplibre-gl-shared.mjs"`, resolved relative to the
 * worker's own URL — so both files must be served from the same directory, and serving only
 * the worker gives one that 404s on its first import and fails exactly as silently as the
 * original bug.
 *
 * They are two **literal** route segments rather than one dynamic `[file]` segment, and that
 * is a security choice as much as a Next one: with no parameter there is no request value
 * anywhere near a filesystem path, so path traversal is not mitigated here, it is absent.
 * ADR 0019 puts path and SSRF handling at the top of v2's risk list, and "there is no input"
 * beats any amount of validating one.
 *
 * ## Where this should end up
 *
 * Copying the two files into `public/maplibre/` from a prebuild script is tidier and removes
 * these routes entirely. It needs a directory and a script the map engineer does not own, so
 * it is an open item in `docs/frontend/HANDOFF-map.md` §7 rather than something done here.
 */

/**
 * Read once per process. The bytes come from a locked dependency and cannot change for the
 * lifetime of a deployment, so re-reading per request would be pure syscall.
 */
const cached = new Map<string, string>();

export function serveMapLibreAsset(fileName: string): Response {
  let source = cached.get(fileName);

  if (source === undefined) {
    try {
      /*
       * Joined from constants supplied by the caller's own module, never from a request.
       * `process.cwd()` is the repository root in development and the standalone root in the
       * container.
       */
      source = readFileSync(join(process.cwd(), "node_modules", "maplibre-gl", "dist", fileName), "utf8");
      cached.set(fileName, source);
    } catch {
      /*
       * A 404 here is a map with no basemap. `deck-map.tsx` listens for MapLibre's `error`
       * event and renders that state rather than leaving a black rectangle, because a basemap
       * that fails silently is worse than one that says so.
       */
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response(source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      /*
       * Immutable for this deployment: a version bump produces a new deployment. A worker
       * re-downloaded on every map open would cost a reader half a megabyte for nothing.
       */
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
