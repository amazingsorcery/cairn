"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Route error boundary for `/map`. Source failures degrade per layer, so this only catches
 * render throws. `error` isn't rendered: messages can contain upstream URLs or paths, and
 * Next already logs it server-side.
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
