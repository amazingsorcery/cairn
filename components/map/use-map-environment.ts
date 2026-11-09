"use client";

import * as React from "react";

import { DEFAULT_THEME, readTheme, type Theme } from "@/components/layout/theme";

/**
 * The two environment signals the map has to obey, read the same way in every component
 * that needs them.
 */

/**
 * The current theme as a value. deck.gl and MapLibre don't react to CSS variables, and the
 * theme module doesn't broadcast changes, so this observes `data-theme` read-only.
 *
 * Starts at `DEFAULT_THEME` to match the server render; the effect corrects it.
 */
export function useResolvedTheme(): Theme {
  const [theme, setTheme] = React.useState<Theme>(DEFAULT_THEME);

  React.useEffect(() => {
    setTheme(readTheme());
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * `prefers-reduced-motion`, watched for changes while the page is open. Starts `false` to
 * match the server render; nothing animates before the map is loaded anyway.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  return reduced;
}
