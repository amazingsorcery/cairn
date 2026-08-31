"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The route-level boundary for `/directory`.
 *
 * It should almost never render. The list query and the taxonomy reads are already caught
 * inside the page and degraded in-region (`states.md` §2.4 and §2.5) so that a failure keeps
 * the filter bar interactive; this file covers what is left — a throw during render.
 *
 * Copy is verbatim from `states.md` §1.3. NOTHING from `error` is rendered: a server error
 * message can carry a table name, a query fragment or a file path, and Next has already
 * logged the real error with its digest server-side, which is where an operator looks.
 */
export default function DirectoryError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load this page
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Something on our side failed. Reload, or try again in a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">clear all filters</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
