"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The editorial surface's error boundary. `states.md` §0: two sentences, what happened then
 * what to do, and a real control.
 *
 * AN AUTHORISATION FAILURE NEVER REACHES HERE. `requireEditorPage()` and `requireAdminPage()`
 * call `notFound()`, which renders the 404 rather than throwing — a non-editor must not be
 * able to tell an admin route from a typo. This boundary is for a genuine failure: a database
 * that did not answer, or a render that threw.
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
