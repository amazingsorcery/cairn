"use client";

import * as React from "react";

import { DEFAULT_THEME, readTheme, type Theme } from "@/components/layout/theme";

/**
 * The two environment signals the map has to obey, read the same way in every component
 * that needs them.
 */

/**
 * The theme the document is actually showing, kept current as it changes.
 *
 * deck.gl draws into a canvas and MapLibre loads a whole style file, so neither reacts to a
 * CSS custom property changing. Both have to be told, which means the map needs the theme as
 * a *value* rather than as a class — and it needs to hear about a change, which the theme
 * module does not broadcast. A `MutationObserver` on the one attribute the toggle writes is
 * the read-only way to hear it without adding a second source of truth
 * (`HANDOFF-shell.md` §8: do not read or write `data-theme` yourself).
 *
 * The first render returns `DEFAULT_THEME` rather than reading the DOM, because the server
 * rendered against the same assumption and a mismatch here throws the server's markup away.
 * The effect corrects it immediately afterwards.
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
 * Whether the reader has asked for reduced motion.
 *
 * It is watched rather than read once: the preference can change while the page is open (a
 * system setting, or an assistive tool toggling it), and a map that keeps animating because
 * it sampled the preference at mount is a map that ignores it.
 *
 * The initial value is `false` so the server render and the first client render agree. On a
 * machine that does prefer reduced motion the effect corrects it before any animation is
 * possible, because nothing on this surface animates until the reader loads the map.
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
