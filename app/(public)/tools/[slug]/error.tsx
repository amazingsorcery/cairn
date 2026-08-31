"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * `states.md` §3.7 — the entry itself failed to load. Copy verbatim, controls verbatim:
 * `reload` and `back to the directory`.
 *
 * This is the whole-page case. The partial case (§3.6, the "used in these playbooks" query
 * failing while the entry loads) is not reachable today: `getToolBySlug()` fetches the entry
 * and its citations in one function, so a failure in either throws both. Splitting it needs a
 * second export from `lib/queries/tools.ts`, which this agent does not own — recorded in
 * `docs/frontend/HANDOFF-directory.md`.
 *
 * Nothing from `error` is rendered. A server error message can carry a table name or a query
 * fragment, and Next has already logged the real error with its digest server-side.
 */
export default function ToolError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load this entry
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Reload, or try again in a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">back to the directory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
