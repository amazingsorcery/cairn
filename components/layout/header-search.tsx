import Link from "next/link";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The search entry point in the header.
 *
 * A plain `<form method="get" action="/search">`, so it works with no JavaScript, produces
 * a real, shareable, back-buttonable URL, and needs no client bundle. `/search` reads `q`
 * from `searchParams` (`docs/architecture/sitemap.md` §4), which is exactly what this form
 * submits.
 *
 * The type-ahead on `/search` itself is a separate, richer control owned by that route
 * (`SearchField` + `SuggestList` in `docs/design/components.md`). This one is deliberately
 * dumber: it is on every page in the product and must cost nothing.
 *
 * At 375px there is no room for a field beside the logo, so the header renders the icon
 * link instead — `docs/design/wireframes/01-home.txt` draws exactly that.
 */
export function HeaderSearch({ className }: { className?: string }) {
  return (
    <form
      role="search"
      method="get"
      action="/search"
      className={cn("hidden items-center md:flex", className)}
    >
      <label htmlFor="header-search" className="sr-only">
        search tools and playbooks
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="header-search"
          name="q"
          type="search"
          autoComplete="off"
          placeholder="search tools and playbooks"
          className="h-11 w-56 pl-9 lg:w-72"
        />
      </div>
    </form>
  );
}

/** The 375px stand-in: a 44×44 link to the full search page. */
export function HeaderSearchLink({ className }: { className?: string }) {
  return (
    <Link
      href="/search"
      aria-label="search"
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-md md:hidden",
        "text-foreground-secondary transition-colors hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      <Search className="size-5" aria-hidden="true" />
    </Link>
  );
}
