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
import { mapTiles } from "../config/live";
import { cameraProviderFileSchema } from "../lib/content/schema";

const OUTPUT = join(process.cwd(), "infra", "csp.caddy");

/** CSP source expressions are origin-scoped; emitting a path would imply false precision. */
function originOf(url: string): string {
  return new URL(url).origin;
}

function collectEmbedOrigins(): string[] {
  const dir = join(process.cwd(), "content", "cameras");
  const origins = new Set<string>();

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

  const imgSrc = ["'self'", "data:", "blob:", tileOrigin, ...embedOrigins].join(" ");

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
    "connect-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const lines = [
    "# GENERATED FILE — DO NOT EDIT BY HAND.",
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
