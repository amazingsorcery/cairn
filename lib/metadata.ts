import type { Metadata } from "next";

import { brand } from "@/config/brand";
import { env } from "@/lib/env";

/**
 * The shared metadata helper. Every route builds its `Metadata` through `pageMetadata()`
 * so that titles, canonicals and social cards are consistent and no brand string is ever
 * typed into a route file (product-brief §7).
 *
 * SERVER ONLY. This imports `lib/env`, which parses `process.env` at module load. Never
 * import it from a Client Component.
 *
 * WHY `metadataBase` COMES FROM `APP_URL` AND NOT FROM `brand.domainPlaceholder`
 * -----------------------------------------------------------------------------
 * `brand.domainPlaceholder` is `.example` — an RFC 2606 reserved TLD that can never
 * resolve — and `brand.domainRegistered` is `false`. It is a placeholder for a *brand*
 * identifier, not a deployment address. `APP_URL` is the origin this instance is actually
 * served from, which is the only thing a canonical URL or an Open Graph image URL may be
 * built from. The two are independent and stay independent after a domain is bought.
 */

/** The origin this instance is served from. Validated at boot by `lib/env`. */
export const SITE_URL: URL = new URL(env.APP_URL);

/** Absolute URL for a site-relative path. Leading slash required. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/**
 * The site-wide default title. Sentence case, no full stop (`docs/brand/voice.md` §5).
 * The en dash is the brand's own separator; the title template below uses a middle dot so
 * the two are never confused when a page title itself contains a dash.
 */
const DEFAULT_TITLE = `${brand.name} — ${brand.tagline}`;

export interface PageMetadataInput {
  /** Page title without the site suffix. The template appends it. */
  title: string;
  /** Meta description. Write a real one; do not fall back to the site description. */
  description: string;
  /** Site-relative path, used for the canonical URL and the Open Graph URL. */
  path: string;
  /**
   * Set `false` on any page that must not be indexed. The `X-Robots-Tag: noindex` header
   * on `/admin/*`, `/workspaces/*` and `/api/*` is applied at the edge (architecture
   * HANDOFF §10) and `app/robots.ts` disallows them too — this is the third layer, for a
   * page that is public but should not be a search result.
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

/**
 * Metadata for the root layout. Everything else inherits from it and overrides what it
 * needs. `title.template` is what turns `title: "Methodology"` into the full document
 * title, so no page ever writes the product name.
 */
export const rootMetadata: Metadata = {
  metadataBase: SITE_URL,
  title: {
    default: DEFAULT_TITLE,
    template: `%s · ${brand.name}`,
  },
  description: brand.description,
  applicationName: brand.name,
  // Sentence-case keywords are not used: they are ignored by every major engine and would
  // be one more place a brand string could be hardcoded.
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
    // No `site` or `creator` handle: `brand.socialsRegistered` is `false`, so there is no
    // handle to name. Adding one would assert an account that does not exist.
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
  // No `verification` block and no third-party site-verification tokens: every one of them
  // is a request to a third party on a page our readers load (product-brief §3.2).
};
