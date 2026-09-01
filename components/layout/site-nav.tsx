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
 *
 * ## `signInEnabled`
 *
 * In public-only mode — no GitHub OAuth and no SMTP, so no accounts (ADR 0032) —
 * `/workspaces` and `/admin` answer 404, and a nav entry pointing at a 404 is the dead link
 * the brief forbids. The flag comes from the server through `SiteHeader`, because a Client
 * Component cannot read the environment.
 *
 * It gates the COMPONENT that reads the session, not just its output. `useSession` costs a
 * `/api/auth/session` request per page view, and in this mode the answer is always "nobody",
 * so the whole subscription is skipped rather than ignored — which is also why the root
 * layout can drop the provider entirely. A leftover session cookie from a deployment that
 * once had a provider therefore cannot resurrect a link to a route that now 404s.
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

function StackedNavItem({
  link,
  pathname,
  onNavigate,
}: {
  link: NavLink;
  pathname: string;
  onNavigate?: () => void;
}) {
  const current = isCurrent(link, pathname);
  return (
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
  );
}

/**
 * The links that depend on who is asking.
 *
 * `editor` and `admin` both reach `/admin`; only `admin` reaches `/admin/connectors`, which
 * is gated inside that section rather than here. Mirrors `isEditor` in `lib/auth.ts`; the
 * server re-checks the role on every admin request regardless — a hidden link is not
 * authorisation.
 */
function useSessionLinks(): NavLink[] {
  const { data: session } = useSession();
  const role = session?.user?.role;
  return [
    ...(session ? SESSION_NAV : []),
    ...(role === "editor" || role === "admin" ? EDITOR_NAV : []),
  ];
}

/** Separate components so that `useSession` is not merely ignored in public-only mode — it
 * is never called. A hook cannot be conditional; a component can. */
function SessionNavItems({ pathname }: { pathname: string }) {
  return (
    <>
      {useSessionLinks().map((link) => (
        <li key={link.href}>
          <NavItem link={link} pathname={pathname} />
        </li>
      ))}
    </>
  );
}

function StackedSessionNavItems({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {useSessionLinks().map((link) => (
        <li key={link.href}>
          <StackedNavItem link={link} pathname={pathname} onNavigate={onNavigate} />
        </li>
      ))}
    </>
  );
}

export function SiteNav({
  className,
  signInEnabled,
}: {
  className?: string;
  signInEnabled: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className={className}>
      <ul className="flex items-center gap-1">
        {PRIMARY_NAV.map((link) => (
          <li key={link.href}>
            <NavItem link={link} pathname={pathname} />
          </li>
        ))}
        {signInEnabled ? <SessionNavItems pathname={pathname} /> : null}
      </ul>
    </nav>
  );
}

/**
 * The same links, stacked, for the mobile sheet. Rows are full-width and 44px tall so a
 * thumb hits the row rather than the word.
 */
export function SiteNavStacked({
  onNavigate,
  signInEnabled,
}: {
  onNavigate?: () => void;
  signInEnabled: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col">
        {PRIMARY_NAV.map((link) => (
          <li key={link.href}>
            <StackedNavItem link={link} pathname={pathname} onNavigate={onNavigate} />
          </li>
        ))}
        {signInEnabled ? (
          <StackedSessionNavItems pathname={pathname} onNavigate={onNavigate} />
        ) : null}
      </ul>
    </nav>
  );
}
