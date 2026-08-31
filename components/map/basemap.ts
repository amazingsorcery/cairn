/**
 * The basemap provider. One declaration, read by the map and by the attribution control.
 *
 * ## Why not `tile.openstreetmap.org`
 *
 * `config/live.ts` still points the v1 Leaflet map at `tile.openstreetmap.org`, with a
 * comment saying a deployment with real traffic must move off it. The OSMF Tile Usage
 * Policy is explicit that the tiles are a service for OSM's own use and that "heavy use"
 * and bulk downloading are forbidden; a production map is exactly the case it excludes.
 * Since the v2 map is the product's **primary surface** rather than an opt-in extra on one
 * route, that "must move" is now due, and it is due before the first deploy rather than
 * after the first abuse email.
 *
 * ## Why OpenFreeMap
 *
 * Checked against https://openfreemap.org on 2026-08-31. Its terms, quoted:
 *
 *   - "There's no registration, no user database, no API keys, and no cookies."
 *   - "There are no limits on the number of map views or requests."
 *   - Commercial use: "Yes".
 *   - "Attribution is required."
 *
 * Three of those matter to this product specifically, not just conveniently:
 *
 * 1. **No API key** means no runtime secret for a client-side asset. A keyed provider
 *    (CARTO, MapTiler, Stadia) puts the key in the browser, where it is public by
 *    construction, and adds a per-deployment credential to a build that ADR 0018 says must
 *    not require runtime secrets.
 * 2. **No cookies and no user database** is the same property this product demands of
 *    itself. A basemap that sets a cookie on an investigative journalist's browser would
 *    undo the reason `/live` fetches through our server.
 * 3. **Self-hosting is documented** — OpenFreeMap publishes the processed planet images —
 *    so the failure mode of a donation-funded single-operator service is "stand up our own
 *    tile host", not "the map is gone". That escape hatch is the reason this is an
 *    acceptable dependency despite having no SLA. See `docs/frontend/HANDOFF-map.md` §7.
 *
 * ## Where this belongs
 *
 * `config/live.ts`, next to `mapTiles`, because `scripts/generate-csp.ts` reads that file
 * to build `infra/csp.caddy` (ADR 0017) and a tile origin the CSP does not know about is a
 * map that works in development and is silently blank in production. The map engineer does
 * not own `config/`, so the declaration lives here and the move is an open item in
 * `docs/frontend/HANDOFF-map.md` §7. **Do not hardcode a tile URL anywhere else.**
 */

/** A named style on the provider, chosen per theme so the map is legible in both. */
export interface BasemapStyle {
  readonly id: string;
  readonly url: string;
}

export const basemap = {
  /** CSP `connect-src` and `img-src` both need this origin. See HANDOFF-map.md §7. */
  origin: "https://tiles.openfreemap.org",

  /**
   * Two styles, not one. A single style forces either dark text on a dark page or a white
   * rectangle in a dark room, and this product's default theme is dark (ADR 0016 §4).
   * `positron` and `dark` are the same cartography at two lightnesses, so switching themes
   * changes the ink and not the map.
   */
  styles: {
    light: { id: "positron", url: "https://tiles.openfreemap.org/styles/positron" },
    dark: { id: "dark", url: "https://tiles.openfreemap.org/styles/dark" },
  },

  /**
   * Rendered on the map, always visible, never in a page footer. Attribution is a condition
   * of use for both the tiles and the underlying data, so a missing credit here is a licence
   * breach and not a polish defect.
   */
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
