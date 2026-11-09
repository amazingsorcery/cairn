"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Admin error boundary, for DB or render failures only. Auth failures never reach here:
 * the guards call `notFound()` so a non-editor can't tell an admin route from a typo.
 */
export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">This page didn&rsquo;t load</h1>
      <p className="mt-3 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
        The read failed before anything was rendered, so nothing was changed. Try again, or go
        back to the queue.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button className="h-11" onClick={reset}>
          try again
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/admin/queue">verification queue</Link>
        </Button>
      </div>
    </div>
  );
}
