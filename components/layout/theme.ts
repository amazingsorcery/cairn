/**
 * Theme state. Shared by the inline boot script in `app/layout.tsx` and by the toggle.
 *
 * RESOLUTION ORDER — ADR 0016 §4
 * ------------------------------
 *   1. an explicit stored choice, from a previous use of the toggle
 *   2. the operating system's `prefers-color-scheme`
 *   3. dark
 *
 * The product is dark-first (`docs/product-brief.md` §1) and `app/tokens.css` defines the
 * dark palette on bare `:root`, with the light palette on `[data-theme="light"]`. But
 * "dark-first" describes which theme is designed and tested against first; it is not a
 * licence to override a preference the reader has already expressed at OS level. A light
 * preference is frequently set for astigmatism, low vision, or a bright room. Dark stays
 * the default where no signal exists at all.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "theme";

/** Used when there is no stored choice and no OS preference to read. */
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/**
 * The boot script, inlined into the document before any content is painted.
 *
 * WHY THIS IS AN INLINE SCRIPT AND NOT A COMPONENT
 * ------------------------------------------------
 * `localStorage` and `matchMedia` are only readable on the client, and anything React
 * renders runs after first paint — the reader would see one frame of the wrong theme. The
 * only way to set `data-theme` before the browser paints is a synchronous, render-blocking
 * script in the document itself. ADR 0016 §5 records why the alternatives (accept the
 * flash; serve it from `public/theme.js`) were rejected.
 *
 * It is wrapped in `try/catch` because reading `localStorage` throws outright in a Safari
 * private window and wherever site data is blocked. A reader with storage disabled falls
 * through to the OS preference, and then to dark, which is the correct failure.
 *
 * The content is a string literal built from two other literals in this file. **Nothing
 * user-controlled is interpolated into it and nothing ever may be** — ADR 0016 §5 makes
 * that a condition of the exception it grants.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":${JSON.stringify(
  DEFAULT_THEME,
)}}document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

/** Apply a theme to the document and remember it. Client only. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked. The theme still applies for this page view; it just will not
    // survive a reload. Silently degrading is right here — there is nothing to tell the
    // reader and nothing they could do about it from this button.
  }
}

/**
 * What the document is actually set to right now. Client only.
 *
 * The boot script always writes the attribute, so this reads a real value rather than
 * guessing. If the script did not run — JavaScript disabled, or it threw — the page is
 * rendering the `:root` dark palette, and `DEFAULT_THEME` is the honest answer.
 */
export function readTheme(): Theme {
  const attribute = document.documentElement.getAttribute("data-theme");
  return isTheme(attribute) ? attribute : DEFAULT_THEME;
}
