/**
 * Configuration for the Live pillar (ADR 0011).
 *
 * Values here feed the generated CSP allowlist (ADR 0017), so changing one means
 * re-running `pnpm csp:generate` and committing the result. CI fails if they disagree.
 */

/**
 * Map tiles.
 *
 * WAS `tile.openstreetmap.org`, which was wrong: the OSM tile usage policy explicitly
 * forbids production use of that endpoint, and "we are small and it is click-to-load" is
 * not an exemption it offers. The map engineer caught that `/live/flights` was still
 * pointing at it after `/map` had moved off.
 *
 * Now OpenFreeMap, which is the same provider `components/map/basemap.ts` uses. Its terms,
 * read 2026-08-31: no registration, no API key, no cookies, no request limit, commercial
 * use permitted, attribution required.
 *
 * The no-API-key property is doing real work: a keyed tile provider means a runtime secret
 * inside a client-side asset, which is not a thing that can be kept. The no-cookies property
 * is one this product demands of itself and should therefore demand of what it embeds.
 *
 * It is a donation-funded service with no SLA. The mitigation is that self-hosting is
 * documented and they publish processed planet images, so the failure mode is "stand up our
 * own tile host", not "the map is gone".
 *
 * Changing the provider means changing `origin` here AND in `components/map/basemap.ts`,
 * then regenerating the CSP.
 */
export const mapTiles = {
  origin: "https://tiles.openfreemap.org",
  urlTemplate: "https://tiles.openfreemap.org/styles/dark",
  maxZoom: 20,
  /** Rendered visibly on the map, not in a footer. Required by the licence. */
  attribution: "© OpenFreeMap contributors, © OpenMapTiles, © OpenStreetMap contributors",
  attributionUrl: "https://openfreemap.org/",
} as const;

/**
 * How stale live data may be before the UI says so rather than showing it silently.
 * ADR 0011 rule 5: never a spinner that lies.
 */
export const liveFreshness = {
  /** Below this, data is presented without qualification. */
  freshSeconds: 30,
  /** Above this, the surface states the age prominently and stops auto-refreshing. */
  staleSeconds: 300,
} as const;
