"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * `/playbooks` error boundary. Doesn't render `error`: it may contain internals, and Next
 * logs it server-side.
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
