import type { LayerColour, Rgba } from "./types";

/**
 * The two colours the map resolves per layer, per theme.
 *
 * deck.gl draws into a WebGL canvas and cannot read a CSS custom property, so these are the
 * literal counterparts of the tokens in `app/tokens.css` §1. Every literal records the token
 * it came from, so a palette change has a name to grep for.
 */

/**
 * The selected-feature ring, shared by every layer.
 *
 * It is deliberately NOT a lighter version of the layer's own colour. With several layers on
 * at once, "selected" has to read as one thing regardless of which layer the feature belongs
 * to, and a per-layer selection tint makes the amber selection ring look like a fifth
 * earthquake colour. This is `--foreground` in each theme: maximum contrast against both
 * basemaps, and the same visual grammar as a focus ring elsewhere in the product.
 *
 * Selection is never carried by colour alone. The ring is also thicker, the row is marked
 * `aria-pressed` in the table, and the detail panel names the feature in its heading.
 */
export const SELECTION_RING: { dark: Rgba; light: Rgba } = {
  /** --slate-100 #E5ECF3 */
  dark: [229, 236, 243, 255],
  /** --slate-950 #05080C */
  light: [5, 8, 12, 255],
};

export type ResolvedTheme = "dark" | "light";

/** The layer's fill for the current theme. */
export function layerColour(colour: LayerColour, theme: ResolvedTheme): Rgba {
  return theme === "dark" ? colour.dark : colour.light;
}

/** `rgb(242 201 122 / 86%)` — the same literal the canvas uses, for the legend swatch. */
export function cssColour(colour: Rgba): string {
  const [r, g, b, a] = colour;
  return `rgb(${r} ${g} ${b} / ${Math.round((a / 255) * 100)}%)`;
}
