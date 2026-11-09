import Link from "next/link";

import { brand } from "@/config/brand";
import { isSignInEnabled } from "@/lib/session-surface";
import { AccountMenu } from "./account-menu";
import { HeaderSearch, HeaderSearchLink } from "./header-search";
import { BrandLockup } from "./logo";
import { MobileNav } from "./mobile-nav";
import { SiteNav } from "./site-nav";
import { ThemeToggle } from "./theme-toggle";

/**
 * Sticky site header (`globals.css` sets `scroll-padding-top` so anchors clear it). Server
 * Component; only nav, mobile sheet, account and theme are client leaves.
 *
 * `isSignInEnabled()` is read here on the server and passed down. In public-only mode the
 * session nav entry and account control don't render, so `useSession` is never called.
 */
export function SiteHeader() {
  const signInEnabled = isSignInEnabled();

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-[80rem] items-center gap-2 px-4 md:h-16 md:gap-4 md:px-6">
        <MobileNav signInEnabled={signInEnabled} />

        {/* Screen-reader suffix so the link announces itself as the way home. */}
        <Link href="/" className="inline-flex h-11 items-center rounded-md px-1 text-foreground">
          <BrandLockup />
          <span className="sr-only">{` — ${brand.tagline}. Home`}</span>
        </Link>

        <SiteNav className="hidden md:ml-2 md:block" signInEnabled={signInEnabled} />

        <div className="ml-auto flex items-center gap-1 md:gap-2">
          <HeaderSearch />
          <HeaderSearchLink />
          {/* Theme toggle shows at every width; on mobile sign-in moves into the sheet. */}
          <ThemeToggle />
          {signInEnabled ? (
            <div className="hidden md:block">
              <AccountMenu signInEnabled />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
