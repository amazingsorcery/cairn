"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * `/workspaces` failed to load.
 *
 * The second sentence answers the question a researcher actually has when a page holding
 * their case file breaks, which is not "what went wrong" but "did I lose anything". It is
 * true: nothing here writes on read.
 */
export default function WorkspacesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load your cases
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          The list didn&rsquo;t come back. Nothing was changed — reload, or try again in a
          minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/playbooks">browse playbooks</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
