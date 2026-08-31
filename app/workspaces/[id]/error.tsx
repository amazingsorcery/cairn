"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The case page failed to load.
 *
 * The second sentence is the important one. A researcher whose case file just showed an
 * error asks one question first — "is my work gone?" — and it is worth a clause to answer
 * it. It is true: rendering this page writes nothing.
 */
export default function WorkspaceDetailError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load this case
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Nothing was changed — your notes, ticks and saved tools are as you left them.
          Reload, or try again in a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/workspaces">all your cases</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
