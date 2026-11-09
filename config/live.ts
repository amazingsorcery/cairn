/**
 * Live map configuration.
 *
 * Values here feed the generated CSP allowlist; after changing one, run
 * `pnpm csp:generate` and commit the result. CI fails if they disagree.
 */

/**
 * Map tiles from OpenFreeMap (same provider as `components/map/basemap.ts`). Terms read
 * 2026-08-31: no key, no cookies, no request limit, commercial use OK, attribution required.
 * No SLA, but self-hosting is possible.
 *
 * To change provider, update `origin` here and in `components/map/basemap.ts`, then
 * regenerate the CSP.
 */
export const mapTiles = {
  origin: "https://tiles.openfreemap.org",

  /**
   * MapLibre vector style URLs, one per theme. OpenFreeMap has no raster endpoint, so
   * there is no `{z}/{x}/{y}` template.
   */
  styleUrls: {
    light: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
  },

  /** Dark, for a caller that cannot read the theme. Prefer `styleUrls`. */
  styleUrl: "https://tiles.openfreemap.org/styles/dark",

  /** Rendered visibly on the map, not in a footer. Required by the licence. */
  attribution: "© OpenFreeMap contributors, © OpenMapTiles, © OpenStreetMap contributors",
  attributionUrl: "https://openfreemap.org/",
} as const;

/** How stale live data may be before the UI says so. */
export const liveFreshness = {
  /** Below this, data is presented without qualification. */
  freshSeconds: 30,
  /** Above this, the surface states the age prominently and stops auto-refreshing. */
  staleSeconds: 300,
} as const;
