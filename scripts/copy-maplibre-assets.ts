/**
 * Copies MapLibre's worker bundles into `public/maplibre/` before the build.
 *
 * WHY THIS EXISTS, because the failure it prevents is genuinely hard to diagnose.
 *
 * `maplibre-gl@6` locates its worker with `new URL("./maplibre-gl-worker.mjs",
 * import.meta.url)`. That template is dynamic, so webpack never emits the file and
 * `import.meta.url` resolves into `/_next/static/chunks/`. MapLibre requests a chunk that was
 * never built, Next answers with its HTML 404, and the browser refuses it on MIME type.
 *
 * The symptom is not an error. deck.gl draws on its own canvas, so the DATA renders
 * perfectly; MapLibre parses tiles inside the worker, so with no worker it never even issues
 * a tile request. You get a black rectangle with correct points on it, which reads as a
 * styling bug and is not one.
 *
 * Serving them from a route that `readFileSync`s out of `node_modules` fixes it in
 * development and breaks again in the container: Next's output tracer cannot see a computed
 * path, and maplibre is imported only from `"use client"` modules, so nothing pulls it into
 * the standalone bundle. Same shape as the pdfkit AFM problem already handled in
 * `next.config.ts` — a green build and a broken deploy.
 *
 * Copying to `public/` sidesteps both: static assets are copied wholesale into the image and
 * served from our own origin, so there is no tracer to satisfy and no CSP origin to widen.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Both files: the worker imports the shared chunk at runtime. */
const ASSETS = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"] as const;

function main(): void {
  // Resolve through the package's own manifest rather than its main entry: maplibre-gl
  // declares `exports` without a bare main, so `require.resolve("maplibre-gl")` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving package.json works regardless of how the
  // package gates its entry points, and still survives a hoisting or package-manager change
  // — which is the reason not to hand-write a node_modules path here.
  const manifest = require.resolve("maplibre-gl/package.json");
  const distDir = join(dirname(manifest), "dist");
  const outDir = join(process.cwd(), "public", "maplibre");
  mkdirSync(outDir, { recursive: true });

  const missing: string[] = [];
  for (const asset of ASSETS) {
    const from = join(distDir, asset);
    if (!existsSync(from)) {
      missing.push(asset);
      continue;
    }
    copyFileSync(from, join(outDir, asset));
    console.log(`maplibre: copied ${asset}`);
  }

  if (missing.length > 0) {
    // Fail the build rather than ship a map that renders a black rectangle. A missing worker
    // produces no error at runtime, so this is the only place it can be caught loudly.
    console.error(
      `maplibre: missing ${missing.join(", ")} in ${distDir}. ` +
        "The basemap cannot render without them and the failure is silent at runtime.",
    );
    process.exit(1);
  }
}

main();
