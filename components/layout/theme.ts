/**
 * Theme state. Shared by the inline boot script in `app/layout.tsx` and by the toggle.
 *
 * The product is dark-first (`docs/product-brief.md` §1). `app/tokens.css` defines the
 * dark palette on bare `:root` and the light palette on `[data-theme="light"]`, so the
 * *absence* of the attribute is dark. `docs/design/states.md` §1.5 defines the toggle as
 * `dark` (default) → `light` and says nothing about following the operating system, and
 * `tokens.css` contains no `prefers-color-scheme` block at all. So this implementation
 * reads a stored choice and nothing else: a first-time visitor gets dark regardless of
 * their OS setting. That is a product decision, not an oversight — see
 * `docs/frontend/HANDOFF-shell.md` §8 for the one-line change if it should follow the OS.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "theme";

export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/**
 * The boot script, inlined into the document before any content is painted.
 *
 * WHY THIS IS AN INLINE SCRIPT AND NOT A COMPONENT
 * ------------------------------------------------
 * `localStorage` is only readable on the client, and any React-rendered solution runs
 * after first paint — the reader sees a dark page flash to light. The only way to set
 * `data-theme` before the browser paints is a synchronous, render-blocking script in the
 * document itself. It is deliberately tiny, has no dependencies, and does one thing.
 *
 * It is wrapped in `try/catch` because reading `localStorage` throws outright in a Safari
 * private window and wherever site data is blocked. A reader with storage disabled gets
 * the default theme, which is the correct failure.
 *
 * Rendered as `<script>{THEME_INIT_SCRIPT}</script>`. React writes the children of a
 * `<script>` element as raw text (it escapes only a literal closing-script sequence), so
 * this needs no `dangerouslySetInnerHTML` — which is lint-banned in this repo anyway.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;

/** Apply a theme to the document and remember it. Client only. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked. The theme still applies for this page view; it just will not
    // survive a reload. Silently degrading is right here — there is nothing to tell the
    // user and nothing they can do about it from this button.
  }
}

/** What the document is actually set to right now. Client only. */
export function readTheme(): Theme {
  const attribute = document.documentElement.getAttribute("data-theme");
  return isTheme(attribute) ? attribute : DEFAULT_THEME;
}
