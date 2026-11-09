"use client";

import * as React from "react";

import { ageSeconds } from "./live-format";

/**
 * Age of the data in whole seconds, recomputed every second from the payload's `fetchedAt`
 * (cached with the data, so it's right whichever cache served it). A timer from mount would
 * measure the page's age instead.
 *
 * `initialSeconds` comes from the server render to avoid a hydration mismatch.
 */
export function useLiveAge(fetchedAt: string | null, initialSeconds: number | null): number | null {
  const [age, setAge] = React.useState<number | null>(initialSeconds);

  React.useEffect(() => {
    if (!fetchedAt) {
      setAge(null);
      return;
    }
    setAge(ageSeconds(fetchedAt));
    const timer = window.setInterval(() => setAge(ageSeconds(fetchedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [fetchedAt]);

  return age;
}
