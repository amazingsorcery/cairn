import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/metadata";

/**
 * `robots.txt`, static at build. Advisory only; the edge sets `X-Robots-Tag: noindex` on
 * these paths, and all of them are behind a session or role check anyway. This just saves
 * crawl traffic on a small VPS.
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
          // Route handlers. `/api/search/suggest` exposes partial queries.
          "/api/",
        ],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
