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
 * The header. Sticky at `--z-sticky`; `globals.css` already sets
 * `scroll-padding-top: 5rem` so an anchored playbook step or a `/methodology` anchor never
 * lands underneath it.
 *
 * 56px tall at 375px (`docs/design/wireframes/01-home.txt`), 64px from `md` where the nav
 * moves inline. This component is a Server Component; only the four leaves that genuinely
 * need the browser — nav (current path), mobile sheet, account, theme — are clients.
 *
 * IT IS ALSO WHERE THE DEPLOYMENT MODE ENTERS THE CLIENT TREE. `isSignInEnabled()` reads the
 * environment, which only the server can do; the boolean is passed down as a prop rather than
 * read again in each leaf. In public-only mode (ADR 0032) there is no account, no
 * `/workspaces` and no `/signin`, so neither the session nav entry nor the account control
 * renders — and, because the leaves are split so that `useSession` is never called, the root
 * layout drops the session provider too.
 */
export function SiteHeader() {
  const signInEnabled = isSignInEnabled();

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-14 w-full max-w-[80rem] items-center gap-2 px-4 md:h-16 md:gap-4 md:px-6">
        <MobileNav signInEnabled={signInEnabled} />

        {/*
          The lockup renders the product name as visible text, so the link already has an
          accessible name. The tagline is appended for screen readers only, because "Cairn,
          link" on its own does not say that this is the way home — the same reason a
          sighted reader gets the lockup rather than a bare glyph.
        */}
        <Link href="/" className="inline-flex h-11 items-center rounded-md px-1 text-foreground">
          <BrandLockup />
          <span className="sr-only">{` — ${brand.tagline}. Home`}</span>
        </Link>

        <SiteNav className="hidden md:ml-2 md:block" signInEnabled={signInEnabled} />

        <div className="ml-auto flex items-center gap-1 md:gap-2">
          <HeaderSearch />
          <HeaderSearchLink />
          {/*
            The theme toggle stays in the header at every width — `01-home.txt` draws it in
            the 375px bar, and it is the one control a reader may want before they have read
            anything, which is a poor reason to make them open a menu first.

            Sign-in does not: at 375px it lives in the sheet, which is where the wireframe
            puts it and where there is room for a real 44px target beside a label.
          */}
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
