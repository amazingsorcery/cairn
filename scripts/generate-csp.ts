/**
 * Generates `infra/csp.caddy` from the data that determines it. See ADR 0017.
 *
 * The `img-src` allowlist depends on which camera providers we are permitted to embed,
 * which is content and therefore changes. Hand-maintaining it guarantees drift, and the
 * failure mode is invisible locally (no CSP in development) and total in production
 * (every embed silently blocked).
 *
 * Run `pnpm csp:generate` and commit the result. CI regenerates and fails on a diff, so a
 * content change cannot ship without its CSP change and vice versa. Widening a security
 * policy should be visible in a diff that a human reads.
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
 * Camera still-image origins, from BOTH places a camera can now come from.
 *
 * `content/cameras/*.json` is the committed registry — link-only operators and hand-noted
 * cameras. `lib/sources/cameras/` is the live-catalogue providers, which serve thousands of
 * cameras from a handful of operator hosts and have no JSON row to read an origin from.
 *
 * Missing the second set would be the exact failure ADR 0017 exists to prevent, arriving from
 * a new direction: invisible in development, where no CSP is applied, and total in
 * production, where every still is silently blocked. Video and audio need no entry —
 * `media-src 'self' https:` already covers them.
 */
function collectEmbedOrigins(): string[] {
  const dir = join(process.cwd(), "content", "cameras");
  const origins = new Set<string>(CAMERA_STILL_IMAGE_ORIGINS.map(originOf));

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const parsed = cameraProviderFileSchema.parse(raw);
    for (const camera of parsed.cameras) {
      // Only permitted embeds. A link-only entry has no embedUrl by schema rule, and
      // allowlisting a host we may not load from would defeat the point of the check.
      if (camera.embedPermitted && camera.embedUrl) {
        origins.add(originOf(camera.embedUrl));
      }
    }
  }

  return [...origins].sort();
}

/**
 * Origins that are shared infrastructure rather than an operator's own host.
 *
 * Allowlisting `s3-eu-west-1.amazonaws.com` admits *every* public bucket in that region,
 * not just the transport authority's. That is far tighter than `img-src https:` but much
 * looser than it looks, and it is exactly the kind of thing that passes review unnoticed
 * because the hostname appears specific. Flagged in the output so a reader sees it.
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

  // The basemap origin is read from `components/map/basemap.ts` rather than restated, so a
  // provider change cannot land without the policy following it. `config/live.ts` carries the
  // same origin for /live/flights; both are included and de-duplicated in case they diverge.
  const basemapOrigin = originOf(basemap.origin);
  const tileOrigins = [...new Set([tileOrigin, basemapOrigin])].sort();

  /*
   * Raster tile hosts that a Toolbench tool loads directly in the reader's browser.
   *
   * NASA GIBS satellite imagery is fetched as <img> by the imagery comparator, so it needs
   * img-src and NOT connect-src. Client-side is the correct place for it — §2b says the
   * browser connects to the source and we never relay media, and satellite tiles are exactly
   * that. Terms verified in docs/sources/nasa-gibs.md: no key, attribution rendered on the map.
   */
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
    // Nothing is framed: camera feeds are still images, the map is a canvas. A provider
    // requiring an iframe would need its own ADR — framing third-party content has
    // clickjacking and privacy properties an <img> does not.
    "frame-src 'none'",
    "form-action 'self' https://github.com",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self'",
    // MapLibre fetches the style JSON, TileJSON, vector tiles and glyph ranges over XHR, so
    // the tile origin needs connect-src as well as img-src. Without this the map renders a
    // black rectangle with correct data drawn on it — deck.gl has its own canvas, so the
    // points look perfect while the basemap never loads. That reads as a styling bug and is
    // not one, which is exactly why it must not be discovered in production.
    `connect-src 'self' ${tileOrigins.join(" ")}`,
    // MapLibre constructs its web worker from a blob URL. Without blob: in worker-src it
    // never starts, never parses a tile, and never even issues a tile request.
    "worker-src 'self' blob:",
    // Fallback for engines that do not implement worker-src.
    "child-src 'self' blob:",
    // Radio Browser streams play client-side, direct from the broadcaster — the §2b rule
    // working as intended. Without media-src this falls back to default-src 'self' and every
    // stream is blocked. `https:` rather than an allowlist because the station list is
    // community-maintained and changes daily; an allowlist would be stale within a week and
    // the alternative is proxying audio, which §2b forbids for good reason.
    // `blob:` is required by Media Source Extensions, which is how hls.js feeds a live
    // stream to a <video>. Measured, not assumed: with `media-src 'self' https:` alone the
    // browser refuses the MSE object URL with "Loading media from 'blob:null/…' violates
    // media-src". It is a narrow addition — a blob URL is minted by our own page and cannot
    // name a remote host.
    //
    // `connect-src` is deliberately NOT widened to `https:` to match. hls.js also fetches
    // the manifest and segments over XHR, which is connect-src, so HLS through the library
    // will not work until a specific origin is allowlisted. That is the intended trade:
    // media-src governs what may be PLAYED, connect-src governs what may be TALKED TO, and
    // on a deployment still carrying `script-src 'unsafe-inline'` a blanket connect-src
    // https: turns any injection into a general exfiltration channel. Widening the thing
    // that plays audio is not the same concession as widening the thing that can post data
    // anywhere, and they should not be waved through together.
    //
    // The practical cost is small and it degrades honestly: HLS plays NATIVELY on Safari and
    // on current Chrome (both measured), so the library path is Firefox-only, and a reader
    // there is told the player could not be loaded and given a link to the operator. No
    // camera provider currently publishes HLS at all. When one does, its origin is a closed
    // committed set and belongs in connect-src via this generator — not a blanket rule.
    "media-src 'self' blob: https:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const lines = [
    "# GENERATED FILE — DO NOT EDIT BY HAND.",
    /*
     * NOTE: `lib/sources/cameras/` is now an input too — see `collectEmbedOrigins`. This
     * line is left as it was on purpose: changing it would rewrite `infra/csp.caddy` and
     * fail `--check` in CI over a comment, on a build where infra is somebody else's file.
     * It is corrected in the same commit as the next real origin change.
     */
    "# Produced by `pnpm csp:generate` from content/cameras/*.json and config/live.ts.",
    "# Rationale: docs/decisions/0017-csp-allowlist-generated-from-content.md",
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
