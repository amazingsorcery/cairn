"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The Live section's error boundary. `docs/design/states.md` §0: two sentences, what
 * happened then what to do, no apology and no "something went wrong", and a real control.
 *
 * A CONNECTOR FAILURE NEVER REACHES HERE. `runConnector` returns a degraded envelope rather
 * than throwing, precisely so that an upstream outage renders as a designed state that says
 * how old the last good data was (ADR 0011 rule 5). This boundary is for the other kind of
 * failure — our own database or render — where there genuinely is nothing to say about age.
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
