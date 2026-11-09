"use client";

import { useEffect } from "react";

/**
 * `beforeunload` guard, armed only while there is unsaved input.
 *
 * No `localStorage` backup: case notes in browser storage on a shared machine are a privacy
 * risk.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      // Modern browsers ignore a custom string and show their own wording; calling
      // `preventDefault` is what actually arms the prompt.
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
