"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Route boundary for `/directory`. Query failures are handled in-region by the page; this
 * only catches render throws. `error` is never shown: it can leak table names or paths.
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
