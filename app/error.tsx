"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The root error boundary. Copy is verbatim from `docs/design/states.md` §1.3, and §1.4
 * when the browser is offline.
 *
 * NOTHING FROM `error` IS RENDERED. Not the message, not the stack, not the digest. A
 * server error message can carry a table name, a file path, a query fragment or an
 * environment detail, and this product's readers are not the people who should be handed
 * any of that. Next.js has already logged the real error server-side with its digest; that
 * is where an operator looks.
 *
 * The offline branch matters because the two failures need different actions: "try again
 * in a minute" is useless advice to someone whose train went into a tunnel, and "check your
 * connection" is useless advice when our own server threw. `navigator.onLine` is only a
 * negative signal — `false` reliably means no network, `true` means very little — which is
 * exactly how it is used here.
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
