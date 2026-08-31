"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Copy verbatim from `docs/design/states.md` §4.6, with both of the controls it names.
 *
 * Nothing from `error` is rendered — not the message, not the digest. Next.js has already
 * logged the real error server-side; a table name or a query fragment is not something to
 * hand a reader.
 */
export default function PlaybookDetailError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load this playbook
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Reload, or try again in a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/playbooks">all playbooks</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
