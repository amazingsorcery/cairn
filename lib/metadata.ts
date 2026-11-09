import type { Metadata } from "next";

import { brand } from "@/config/brand";
import { env } from "@/lib/env";

/**
 * Shared metadata helpers so titles, canonicals and social cards are consistent. Server-only
 * (imports `lib/env`).
 *
 * `metadataBase` uses `APP_URL` (the real origin), not `brand.domainPlaceholder`.
 */

/** The origin this instance is served from. Validated at boot by `lib/env`. */
export const SITE_URL: URL = new URL(env.APP_URL);

/** Absolute URL for a site-relative path. Leading slash required. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/** Default title. The page template uses a middle dot so it isn't confused with this dash. */
const DEFAULT_TITLE = `${brand.name} — ${brand.tagline}`;

export interface PageMetadataInput {
  /** Page title without the site suffix. The template appends it. */
  title: string;
  /** Meta description. Write a real one; do not fall back to the site description. */
  description: string;
  /** Site-relative path, used for the canonical URL and the Open Graph URL. */
  path: string;
  /**
   * `false` for a public page that shouldn't be indexed. Private areas also get
   * `X-Robots-Tag` at the edge and a `robots.ts` disallow.
   */
  index?: boolean;
}

/**
 * Build a route's `Metadata`. Use it in every `export const metadata` and every
 * `generateMetadata`.
 *
 * ```ts
 * export const metadata = pageMetadata({
 *   title: "Methodology",
 *   description: "What each confidence level means…",
 *   path: "/methodology",
 * });
 * ```
 */
export function pageMetadata({
  title,
  description,
  path,
  index = true,
}: PageMetadataInput): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      siteName: brand.name,
      locale: "en_GB",
      title,
      description,
      url: absoluteUrl(path),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    ...(index ? {} : { robots: { index: false, follow: false } }),
  };
}

/** Root layout metadata. `title.template` appends the product name to page titles. */
export const rootMetadata: Metadata = {
  metadataBase: SITE_URL,
  title: {
    default: DEFAULT_TITLE,
    template: `%s · ${brand.name}`,
  },
  description: brand.description,
  applicationName: brand.name,
  // No `keywords`: search engines ignore them.
  authors: [{ name: brand.copyrightHolder }],
  creator: brand.copyrightHolder,
  publisher: brand.copyrightHolder,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: brand.name,
    locale: "en_GB",
    title: DEFAULT_TITLE,
    description: brand.description,
    url: absoluteUrl("/"),
  },
  twitter: {
    // No `site`/`creator` handle: no social accounts are registered.
    card: "summary_large_image",
    title: DEFAULT_TITLE,
    description: brand.description,
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
  formatDetection: { telephone: false, address: false, email: false },
  robots: {
    index: true,
    follow: true,
  },
  // No third-party site-verification tokens.
};
