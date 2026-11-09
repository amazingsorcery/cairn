/**
 * Theme state, shared by the boot script in `app/layout.tsx` and the toggle.
 *
 * Resolution order: stored choice, then `prefers-color-scheme`, then dark. `app/tokens.css`
 * puts the dark palette on `:root` and light on `[data-theme="light"]`.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "theme";

/** Used when there is no stored choice and no OS preference to read. */
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/**
 * Inline boot script that sets `data-theme` before first paint, avoiding a wrong-theme
 * flash. `try/catch` because `localStorage` throws in Safari private mode and when storage
 * is blocked.
 *
 * Built only from constants in this file; never interpolate user-controlled values.
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
    // Storage blocked: the theme applies but won't persist.
  }
}

/**
 * The document's current theme. Client only. Falls back to `DEFAULT_THEME` if the boot
 * script didn't run (the `:root` palette is dark).
 */
export function readTheme(): Theme {
  const attribute = document.documentElement.getAttribute("data-theme");
  return isTheme(attribute) ? attribute : DEFAULT_THEME;
}
