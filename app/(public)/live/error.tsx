"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for Live. Connector failures don't reach here (`runConnector` returns a
 * degraded envelope); this covers our own database or render errors.
 */
export default function LiveError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          This live view didn&rsquo;t load
        </h1>
        <p className="mt-3 text-base leading-relaxed text-foreground-secondary">
          The page failed before it could reach any source, so nothing was requested from an
          operator. Try again, or read what these surfaces draw on.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button className="h-11" onClick={reset}>
            try again
          </Button>
          <Button asChild variant="outline" className="h-11">
            <Link href="/live">about our sources</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
