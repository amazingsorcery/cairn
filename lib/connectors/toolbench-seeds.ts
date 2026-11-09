import { CRTSH_CONNECTOR_SEED } from "./crtsh";
import { DNS_CONNECTOR_SEED } from "./dns";
import { RIPESTAT_CONNECTOR_SEED } from "./ripestat";
import { WAYBACK_CONNECTOR_SEED } from "./wayback";

/**
 * Registry rows for the Toolbench's server-side tools, gathered for one import in
 * `db/seed.ts`. Each row lives beside its driver.
 *
 * All seed disabled/draft (fail closed); a disabled tool still renders, just without a lookup.
 * Two need a decision before enabling (see their `legal_basis`): crt.sh publishes no terms or
 * rate limit, and RIPEstat Art. 3.3 restricts redistribution.
 */
import { OVERPASS_CONNECTOR_SEED } from "./overpass";

export const TOOLBENCH_CONNECTOR_SEEDS = [
  CRTSH_CONNECTOR_SEED,
  DNS_CONNECTOR_SEED,
  RIPESTAT_CONNECTOR_SEED,
  WAYBACK_CONNECTOR_SEED,
  OVERPASS_CONNECTOR_SEED,
] as const;

// Broadcast Finder reuses the map's `radio-browser` row: one upstream, one kill switch.

export {
  CRTSH_CONNECTOR_SEED,
  DNS_CONNECTOR_SEED,
  RIPESTAT_CONNECTOR_SEED,
  WAYBACK_CONNECTOR_SEED,
  OVERPASS_CONNECTOR_SEED,
};
