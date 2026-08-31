"use client";

import { useEffect } from "react";

/**
 * `docs/design/flows.md` M2 — the `beforeunload` guard.
 *
 * The browser's own dialog is the only thing that reliably survives a tab close, so it is
 * what we use rather than a prettier one that does not fire. It is armed only while there
 * is genuinely unsaved input and disarmed the moment a save lands: a guard that fires when
 * nothing is at stake gets dismissed reflexively, and then it is not a guard.
 *
 * NOTHING IS WRITTEN TO `localStorage` AS A BACKUP. A case note in browser storage on a
 * shared machine is a threat-model failure for the audience this product is for
 * (`docs/design/states.md` §7.4). The guard and the autosave are the mitigation; local
 * persistence is not on the table.
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
