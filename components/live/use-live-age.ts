"use client";

import * as React from "react";

import { ageSeconds } from "./live-format";

/**
 * How old the data on screen is, in whole seconds, recomputed every second from the
 * `fetchedAt` inside the payload. ADR 0014 §1.
 *
 * `fetchedAt` is stamped at the moment the upstream answered and is cached WITH the data, so
 * an age derived from it is correct regardless of which cache layer served the payload, how
 * long it sat there, or whether the page came back from bfcache. An age counted from a timer
 * started at mount would be none of those things — it would be the age of the *page*, which
 * on a live surface is a different and misleading number.
 *
 * `initialSeconds` comes from the server render so the first client render matches the
 * server HTML exactly. Without it the age would either be absent in the no-JavaScript
 * rendering or would trip a hydration mismatch and throw the server's markup away.
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
