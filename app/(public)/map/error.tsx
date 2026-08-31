"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The route-level boundary for `/map`.
 *
 * It should almost never render. Every source failure is already caught per layer and
 * degraded in place — one dead upstream disables its own layer and nothing else
 * (product-brief §2b) — so this covers only what is left: a throw during render.
 *
 * Copy follows `docs/design/states.md` §1.3: two sentences, what happened then what to do, no
 * apology and a real control. NOTHING from `error` is rendered. A server error message can
 * carry an upstream URL, a query fragment or a file path, and Next has already logged the real
 * error with its digest server-side, which is where an operator looks.
 */
export default function MapError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Couldn&rsquo;t load the map
        </h1>
        <p className="mt-3 text-base text-foreground-secondary">
          Something on our side failed before any layer could be drawn. Reload, or try again in
          a minute.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            reload
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/live">go to the live sources</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
