/**
 * Basemap provider, read by the map and the attribution control. Don't hardcode a tile URL
 * anywhere else.
 *
 * OpenFreeMap rather than `tile.openstreetmap.org`, whose usage policy excludes heavy
 * production use. OpenFreeMap (terms checked 2026-08-31): no API key (so no secret in the
 * browser), no cookies, no request limits, commercial use allowed, attribution required, and
 * self-hostable if the service goes away.
 *
 * The origin must also be in the CSP (`scripts/generate-csp.ts`), or the map is blank in
 * production.
 */

/** A named style on the provider, chosen per theme so the map is legible in both. */
export interface BasemapStyle {
  readonly id: string;
  readonly url: string;
}

export const basemap = {
  /** CSP `connect-src` and `img-src` both need this origin. */
  origin: "https://tiles.openfreemap.org",

  /** One style per theme; `positron` and `dark` are the same cartography. */
  styles: {
    light: { id: "positron", url: "https://tiles.openfreemap.org/styles/positron" },
    dark: { id: "dark", url: "https://tiles.openfreemap.org/styles/dark" },
  },

  /** Always visible on the map. Required by the tile and data licences. */
  attribution: [
    { text: "OpenFreeMap", href: "https://openfreemap.org" },
    { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
    { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
  ],

  /** The licence on the underlying data, for the record. */
  dataLicence: "ODbL 1.0 (OpenStreetMap)",

  /** Beyond this the provider has no tiles; MapLibre overzooms rather than 404s. */
  maxZoom: 20,
} as const;

export type BasemapTheme = keyof typeof basemap.styles;

/** The style URL for a resolved theme. The only place a style URL is chosen. */
export function basemapStyleUrl(theme: BasemapTheme): string {
  return basemap.styles[theme].url;
}
