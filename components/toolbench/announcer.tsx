"use client";

import * as React from "react";

/**
 * The single polite live region for a Toolbench route. One shared region, since screen
 * readers queue announcements from every region on the page.
 *
 * Rendered by the provider so it exists before any content (a region created with its
 * content announces nothing). Debounced so typing produces one announcement, not one per key.
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

/** Announce into the route's live region. A no-op outside a provider (e.g. in tests). */
export function useAnnounce(): Announce {
  const announce = React.useContext(AnnouncerContext);
  return announce ?? noop;
}

const noop: Announce = () => {};
