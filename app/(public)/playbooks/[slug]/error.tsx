"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Doesn't render `error`: Next logs it server-side, and it may contain internals. */
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
