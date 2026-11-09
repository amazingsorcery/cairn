"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Nothing from `error` is rendered (message, stack or digest), since it
 * can leak internals; Next.js already logs it server-side.
 *
 * Offline gets different copy. `navigator.onLine === false` is reliable; `true` means little.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(!navigator.onLine);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-16 md:px-6 md:py-24">
      <div className="max-w-[68ch]">
        {offline ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">No connection</h1>
            <p className="mt-3 text-base text-foreground-secondary">
              Your browser can&rsquo;t reach us. Check your connection and retry.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Couldn&rsquo;t load this page
            </h1>
            <p className="mt-3 text-base text-foreground-secondary">
              Something on our side failed. Reload, or try again in a minute.
            </p>
          </>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" onClick={reset}>
            {offline ? "retry" : "reload"}
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/directory">browse the directory</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
