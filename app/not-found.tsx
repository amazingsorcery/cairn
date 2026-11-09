import Link from "next/link";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 404. Also rendered for draft or removed entries, so it must not distinguish "never existed"
 * from "not published". The search form works without JavaScript.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Not found</h1>
        <p className="mt-3 text-base text-foreground-secondary">
          There is no page at this address. Try the directory, or search for what you were
          after.
        </p>

        <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-end">
          <Button asChild size="lg" className="sm:w-auto">
            <Link href="/directory">browse the directory</Link>
          </Button>

          <form role="search" method="get" action="/search" className="flex w-full gap-2 sm:max-w-sm">
            <div className="relative flex-1">
              <label htmlFor="not-found-search" className="sr-only">
                search tools and playbooks
              </label>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="not-found-search"
                name="q"
                type="search"
                autoComplete="off"
                placeholder="search tools and playbooks"
                className="h-11 pl-9"
              />
            </div>
            <Button type="submit" variant="outline" size="lg">
              search
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
