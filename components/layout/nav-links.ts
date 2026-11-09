/**
 * Navigation route table for the header, mobile sheet and footer. Only link routes that
 * exist; `tests/nav-links.test.ts` checks each one resolves.
 *
 * Detail and flow routes (`/tools/[slug]`, `/tags/[slug]`, `/signin/check-email`,
 * `/legal/disclaimer`) are intentionally not listed.
 */

export interface NavLink {
  href: string;
  label: string;
  /**
   * Matched as a prefix so `/directory/geospatial-and-imagery` marks `directory` current.
   * `/` is matched exactly; see `isCurrent` below.
   */
  prefixMatch: boolean;
}

/** Always visible. */
export const PRIMARY_NAV: readonly NavLink[] = [
  { href: "/map", label: "map", prefixMatch: true },
  { href: "/toolbench", label: "tools", prefixMatch: true },
  { href: "/directory", label: "directory", prefixMatch: true },
  { href: "/playbooks", label: "playbooks", prefixMatch: true },
  { href: "/live", label: "live", prefixMatch: true },
  { href: "/search", label: "search", prefixMatch: true },
] as const;

/** Visible only to a signed-in user. */
export const SESSION_NAV: readonly NavLink[] = [
  { href: "/workspaces", label: "workspaces", prefixMatch: true },
] as const;

/** Visible only to `editor` and `admin` roles. */
export const EDITOR_NAV: readonly NavLink[] = [
  { href: "/admin", label: "admin", prefixMatch: true },
] as const;

/** Footer links. `/legal/disclaimer` is linked from the terms page instead. */
export const FOOTER_NAV: readonly NavLink[] = [
  { href: "/about", label: "about", prefixMatch: false },
  { href: "/methodology", label: "methodology", prefixMatch: false },
  { href: "/legal/terms", label: "terms", prefixMatch: false },
  { href: "/legal/privacy", label: "privacy", prefixMatch: false },
  { href: "/legal/acceptable-use", label: "acceptable use", prefixMatch: false },
] as const;

/** Is `link` the section the reader is currently in? Drives `aria-current="page"`. */
export function isCurrent(link: NavLink, pathname: string): boolean {
  if (!link.prefixMatch) return pathname === link.href;
  return pathname === link.href || pathname.startsWith(`${link.href}/`);
}
