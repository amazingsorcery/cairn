"use client";

import * as React from "react";

/**
 * The one polite live region on a Toolbench route.
 *
 * `docs/frontend/HANDOFF-shell.md` section 10.1: one live region per route and no more,
 * because a screen reader queues announcements from every region on the page and a reader
 * ends up hearing from parts of the interface they are not in. These tools compute
 * continuously — every keystroke changes a result, and every row has a copy button — so
 * without a single shared region a page like the coordinate converter would have a dozen.
 *
 * The region is rendered by the provider and is therefore in the DOM before any content
 * arrives, which is the other half of the rule: a live region created at the same moment as
 * its content announces nothing.
 *
 * Announcements are debounced. A converter that announced on every keystroke would talk
 * over itself and be worse than silent; waiting until the reader stops typing produces one
 * useful sentence.
 */

type Announce = (message: string) => void;

const AnnouncerContext = React.createContext<Announce | null>(null);

export function Announcer({
  children,
  debounceMs = 700,
}: {
  children: React.ReactNode;
  debounceMs?: number;
}) {
  const [message, setMessage] = React.useState("");
  const timerRef = React.useRef<number | null>(null);

  const announce = React.useCallback<Announce>(
    (next) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        // Re-setting the same string does not re-announce, so a trailing space forces it
        // when a reader repeats an action and expects to hear the confirmation again.
        setMessage((current) => (current === next ? `${next} ` : next));
      }, debounceMs);
    },
    [debounceMs],
  );

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <AnnouncerContext.Provider value={announce}>
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </p>
      {children}
    </AnnouncerContext.Provider>
  );
}

/**
 * Announce into the route's live region. Returns a no-op outside a provider so a component
 * can be rendered in isolation — in a test, or on a page that has not been wrapped yet —
 * without throwing.
 */
export function useAnnounce(): Announce {
  const announce = React.useContext(AnnouncerContext);
  return announce ?? noop;
}

const noop: Announce = () => {};
