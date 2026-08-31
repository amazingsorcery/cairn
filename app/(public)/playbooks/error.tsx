"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * `/playbooks` failed to load. Copy from `docs/design/states.md` §4.6.
 *
 * Nothing from `error` is rendered — not the message, not the digest. A server error can
 * carry a table name or a query fragment, and this product's readers are not the people to
 * hand that to. Next.js has already logged it server-side.
 *
 * Both controls are real: `reload` re-runs the segment, `browse the directory` is the way
 * out if it keeps failing. An error region with no next action is a dead end
 * (`states.md` §0).
 */
export default function PlaybooksError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load the playbooks
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Reload, or try again in a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">browse the directory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
