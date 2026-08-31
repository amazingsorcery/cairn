import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/metadata";

/**
 * `robots.txt`. Static at build (`docs/architecture/sitemap.md` §5).
 *
 * The `X-Robots-Tag: noindex` header on `/admin/*`, `/workspaces/*` and `/api/*` is applied
 * at the edge (architecture HANDOFF §10) and is the enforcement. This file is the polite
 * request that stops a well-behaved crawler spending our request budget on pages it will be
 * told to discard anyway — on a 2 GB VPS with no CDN that is a real saving, not a nicety.
 *
 * Both layers exist on purpose. `robots.txt` is advisory and does not prevent indexing of a
 * URL a crawler learned about elsewhere; `X-Robots-Tag` does. Neither is access control:
 * every one of these paths is also behind a session or a role check in the application.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          // Signed-in case files. Never indexed, never cached, never shared.
          "/workspaces/",
          // Editorial surfaces, including draft entries that are not public.
          "/admin/",
          // Route handlers. `/api/search/suggest` in particular is a partial-query surface
          // that must not end up in any shared index (product-brief §3.2).
          "/api/",
        ],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
