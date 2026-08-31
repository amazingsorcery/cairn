/**
 * Configuration for the Live pillar (ADR 0011).
 *
 * Values here feed the generated CSP allowlist (ADR 0017), so changing one means
 * re-running `pnpm csp:generate` and committing the result. CI fails if they disagree.
 */

/**
 * Map tiles for `/live/flights`.
 *
 * OpenStreetMap's tile usage policy restricts heavy or automated use and requires
 * attribution. At the traffic this deployment expects that is acceptable, and the map is
 * opt-in click-to-load so tiles are not fetched unless a reader asks for them.
 *
 * A deployment with real traffic must move to a paid or self-hosted provider. That is a
 * hosting-terms obligation, not a preference — this note lives next to the value rather
 * than in a document precisely so whoever changes the traffic profile reads it.
 *
 * Changing the provider means changing `origin` here and regenerating the CSP.
 */
export const mapTiles = {
  origin: "https://tile.openstreetmap.org",
  urlTemplate: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  maxZoom: 19,
  /** Rendered visibly on the map, not in a footer. Required by the tile usage policy. */
  attribution: "© OpenStreetMap contributors",
  attributionUrl: "https://www.openstreetmap.org/copyright",
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
