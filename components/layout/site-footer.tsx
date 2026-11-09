import Link from "next/link";

import { brand } from "@/config/brand";
import { FOOTER_NAV } from "./nav-links";

/**
 * Site footer. Social, contact and repo links stay hidden until `brand.domainRegistered` /
 * `brand.socialsRegistered` are set, so we never link to an unclaimed address.
 *
 * Live-data attribution renders next to the data, not here.
 */
export function SiteFooter() {
  const identifiersPending = !brand.domainRegistered || !brand.socialsRegistered;

  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto w-full max-w-[80rem] px-4 py-8 md:px-6 md:py-10">
        <nav aria-label="Site information">
          <ul className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {FOOTER_NAV.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="inline-flex h-11 items-center rounded-md px-3 text-sm text-foreground-secondary transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-4 space-y-2 px-3 text-sm text-muted-foreground md:mt-6">
          <p className="tabular">{brand.copyright}</p>

          {identifiersPending ? (
            <p>
              Pre-launch build. No domain, contact address or account has been registered for
              this project yet, so none is linked here.
            </p>
          ) : null}

          {brand.legal.reviewComplete ? null : (
            <p>
              The policies above are drafts. A qualified lawyer has not reviewed them and some
              facts in them are unconfirmed.
            </p>
          )}
        </div>
      </div>
    </footer>
  );
}
