/**
 * The navigation route table. One source of truth for the header, the mobile sheet and
 * the footer.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: **if it is not built, it is not linked**
 * (product-brief §8, `docs/brand/positioning.md` §8.5). For Persona A this is not a
 * code-quality preference — one dead link in the nav and she concludes the site is
 * abandoned and never comes back.
 *
 * Every path below appears in the "Nav" column of `docs/architecture/sitemap.md`. Nothing
 * else may be added here. A route that exists but is reached only by direct link or
 * redirect (`/tools/[slug]`, `/tags/[slug]`, `/signin/check-email`, `/legal/disclaimer`)
 * is deliberately absent.
 *
 * Labels are lowercase because the wireframes draw them lowercase
 * (`docs/design/wireframes/01-home.txt`) and because `docs/brand/voice.md` §5 forbids
 * Title Case anywhere. They are not brand strings and are safe as literals.
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

/** Always visible. The four pillars plus search (`docs/design/states.md` §1.1). */
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

/**
 * Footer links. `/legal/disclaimer` exists and is reachable from the terms page, but it is
 * not listed here because `docs/design/states.md` §1.1 names exactly these five.
 */
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
