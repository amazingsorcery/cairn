"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { cn } from "@/lib/utils";
import { EDITOR_NAV, isCurrent, PRIMARY_NAV, SESSION_NAV, type NavLink } from "./nav-links";

/**
 * The primary navigation.
 *
 * A Client Component for one reason only: the current section has to be marked, and
 * `usePathname` is the only way to know it. `aria-current="page"` is not decoration — it
 * is how a screen-reader user knows where they are, and the underline that goes with it is
 * how everyone else does.
 *
 * The signed-in and editor links come from `useSession`, so they appear after hydration
 * for the reader who has a session and never render at all for the reader who does not.
 * See `session-provider.tsx` for why the session is not read on the server.
 */

function NavItem({ link, pathname }: { link: NavLink; pathname: string }) {
  const current = isCurrent(link, pathname);
  return (
    <Link
      href={link.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        // 44px tall so the row is a real touch target even though the text is small.
        "inline-flex h-11 items-center rounded-md px-3 text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        current ? "font-semibold text-foreground" : "text-foreground-secondary",
      )}
    >
      {link.label}
    </Link>
  );
}

export function SiteNav({ className }: { className?: string }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;

  const links: NavLink[] = [
    ...PRIMARY_NAV,
    ...(session ? SESSION_NAV : []),
    // `editor` and `admin` both reach `/admin`; only `admin` reaches `/admin/connectors`,
    // which is gated inside that section rather than here. Mirrors `isEditor` in
    // `lib/auth.ts`; the server re-checks the role on every admin request regardless — a
    // hidden link is not authorisation.
    ...(role === "editor" || role === "admin" ? EDITOR_NAV : []),
  ];

  return (
    <nav aria-label="Primary" className={className}>
      <ul className="flex items-center gap-1">
        {links.map((link) => (
          <li key={link.href}>
            <NavItem link={link} pathname={pathname} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The same links, stacked, for the mobile sheet. Rows are full-width and 44px tall so a
 * thumb hits the row rather than the word.
 */
export function SiteNavStacked({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;

  const links: NavLink[] = [
    ...PRIMARY_NAV,
    ...(session ? SESSION_NAV : []),
    ...(role === "editor" || role === "admin" ? EDITOR_NAV : []),
  ];

  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col">
        {links.map((link) => {
          const current = isCurrent(link, pathname);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={onNavigate}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex h-12 items-center rounded-md px-3 text-base transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  current ? "font-semibold text-foreground" : "text-foreground-secondary",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
