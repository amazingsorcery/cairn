/**
 * Generates `infra/csp.caddy`. The img-src allowlist depends on which camera providers may
 * be embedded, so it's derived from content rather than hand-maintained (drift would only
 * show in production, where every embed would be blocked).
 *
 * Run `pnpm csp:generate` and commit the result; CI fails on a diff (`--check`).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basemap } from "../components/map/basemap";
import { mapTiles } from "../config/live";
import { cameraProviderFileSchema } from "../lib/content/schema";
import { CAMERA_STILL_IMAGE_ORIGINS } from "../lib/sources/cameras/origins";

const OUTPUT = join(process.cwd(), "infra", "csp.caddy");

/** CSP source expressions are origin-scoped; emitting a path would imply false precision. */
function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Camera still-image origins from `content/cameras/*.json` and the live-catalogue providers
 * in `lib/sources/cameras/`. Video/audio are covered by `media-src https:`.
 */
function collectEmbedOrigins(): string[] {
  const dir = join(process.cwd(), "content", "cameras");
  const origins = new Set<string>(CAMERA_STILL_IMAGE_ORIGINS.map(originOf));

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const parsed = cameraProviderFileSchema.parse(raw);
    for (const camera of parsed.cameras) {
      // Only permitted embeds.
      if (camera.embedPermitted && camera.embedUrl) {
        origins.add(originOf(camera.embedUrl));
      }
    }
  }

  return [...origins].sort();
}

/**
 * Shared hosting origins, flagged in the output: e.g. `s3-eu-west-1.amazonaws.com` admits
 * every public bucket in the region, not just the operator's.
 */
const SHARED_INFRASTRUCTURE = [
  ".amazonaws.com",
  ".cloudfront.net",
  ".core.windows.net",
  ".googleapis.com",
  ".storage.googleapis.com",
  ".blob.core.windows.net",
  ".cdn.cloudflare.net",
];

function isSharedInfrastructure(origin: string): boolean {
  const host = new URL(origin).hostname;
  return SHARED_INFRASTRUCTURE.some((suffix) => host.endsWith(suffix));
}

function build(): string {
  const embedOrigins = collectEmbedOrigins();
  const tileOrigin = originOf(mapTiles.origin);

  // Both basemap configs, de-duplicated in case they diverge.
  const basemapOrigin = originOf(basemap.origin);
  const tileOrigins = [...new Set([tileOrigin, basemapOrigin])].sort();

  // Raster tiles loaded as <img> by Toolbench tools (NASA GIBS imagery comparator):
  // img-src only. No key; attribution rendered on the map.
  const toolTileOrigins = ["https://gibs.earthdata.nasa.gov"].map(originOf);

  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
    ...tileOrigins,
    ...toolTileOrigins,
    ...embedOrigins,
  ].join(" ");

  const policy = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // Nothing is framed; iframes carry risks an <img> doesn't.
    "frame-src 'none'",
    "form-action 'self' https://github.com",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self'",
    // MapLibre fetches styles, tiles and glyphs over XHR. Without this the basemap is blank
    // while deck.gl points still render.
    `connect-src 'self' ${tileOrigins.join(" ")}`,
    // MapLibre's worker is created from a blob URL.
    "worker-src 'self' blob:",
    // Fallback for engines that do not implement worker-src.
    "child-src 'self' blob:",
    // Radio streams play directly from broadcasters; the station list changes daily, so
    // `https:` rather than an allowlist. `blob:` is needed for MSE (hls.js).
    // connect-src is not widened to match: with 'unsafe-inline' scripts that would allow
    // exfiltration anywhere. So hls.js (Firefox only; Safari/Chrome play HLS natively) needs
    // specific origins added to connect-src here.
    "media-src 'self' blob: https:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const lines = [
    "# GENERATED FILE — DO NOT EDIT BY HAND.",
    "# Produced by `pnpm csp:generate` from content/cameras/*.json and config/live.ts.",
    "# Also reads lib/sources/cameras/ and components/map/basemap.ts.",
    "#",
    "# The `?` prefix means set-if-absent: if the application later ships nonce-based CSP",
    "# middleware, its stricter header wins automatically with no change to this file.",
    "#",
    `# Embedded camera origins (${embedOrigins.length}):`,
    ...embedOrigins.map(
      (o) =>
        `#   ${o}${isSharedInfrastructure(o) ? "   <-- SHARED INFRASTRUCTURE: this admits every tenant on that host, not just the operator" : ""}`,
    ),
    `# Map tile origin: ${tileOrigin}`,
    "",
    "(cairn_csp) {",
    `\theader ?Content-Security-Policy "${policy}"`,
    "}",
    "",
  ];

  return lines.join("\n");
}

const output = build();

if (process.argv.includes("--check")) {
  const existing = readFileSync(OUTPUT, "utf8");
  if (existing !== output) {
    console.error(
      "infra/csp.caddy is out of date with content/cameras/ or config/live.ts.\n" +
        "Run `pnpm csp:generate` and commit the result.\n" +
        "A content change must not ship without the CSP change it requires.",
    );
    process.exit(1);
  }
  console.log("infra/csp.caddy is up to date.");
} else {
  writeFileSync(OUTPUT, output, "utf8");
  console.log(`Wrote ${OUTPUT}`);
}
