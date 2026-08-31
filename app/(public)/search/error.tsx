"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The route-level boundary for `/search`.
 *
 * It should rarely render: the page already catches a failing `search()` and reports it
 * in-region (`states.md` §8.4) so the field stays usable, which is the difference between "the
 * index didn't answer" and "the page is gone". This covers a throw during render.
 *
 * Copy verbatim from `states.md` §8.4, including both controls — retry, and browse the
 * directory by category. Nothing from `error` is rendered.
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
