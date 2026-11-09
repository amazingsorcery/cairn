"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";

import { cn } from "@/lib/utils";
import { EDITOR_NAV, isCurrent, PRIMARY_NAV, SESSION_NAV, type NavLink } from "./nav-links";

/**
 * Primary navigation. Client Component so it can mark the current section via `usePathname`.
 *
 * Signed-in and editor links come from `useSession` after hydration (see
 * `session-provider.tsx`). In public-only mode (no GitHub OAuth or SMTP) `signInEnabled` is
 * false and the session-reading components are not rendered at all, so stale cookies can't
 * surface links to routes that 404.
 */

function NavItem({ link, pathname }: { link: NavLink; pathname: string }) {
  const current = isCurrent(link, pathname);
  return (
    <Link
      href={link.href}
      aria-current={current ? "page" : undefined}
      className={cn(
        // 44px touch target.
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
 * Role-dependent links. Mirrors `isEditor` in `lib/auth.ts`; the server re-checks roles on
 * every admin request, so hiding a link is not authorisation.
 */
function useSessionLinks(): NavLink[] {
  const { data: session } = useSession();
  const role = session?.user?.role;
  return [
    ...(session ? SESSION_NAV : []),
    ...(role === "editor" || role === "admin" ? EDITOR_NAV : []),
  ];
}

/** Separate components so `useSession` is never called in public-only mode. */
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

/** Stacked full-width links for the mobile sheet. */
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
