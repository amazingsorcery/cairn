"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Route boundary for `/search`. A failing `search()` is reported in-region by the page so
 * the field stays usable; this only catches render throws. `error` is never shown.
 */
export default function SearchError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t run that search
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          The search index didn&rsquo;t answer. Retry, or browse the directory by category.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            retry
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">browse the directory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
