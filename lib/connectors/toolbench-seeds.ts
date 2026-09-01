import { CRTSH_CONNECTOR_SEED } from "./crtsh";
import { DNS_CONNECTOR_SEED } from "./dns";
import { RIPESTAT_CONNECTOR_SEED } from "./ripestat";
import { WAYBACK_CONNECTOR_SEED } from "./wayback";

/**
 * The four registry rows the Toolbench's server-side tools need.
 *
 * Collected here so `db/seed.ts` — which this agent does not own — needs exactly one import
 * and one spread to wire all four, rather than four imports that will be added three at a
 * time. Each row lives next to its driver so the endpoint, the licence, the quota envelope
 * and the code that uses them are reviewed together in one file; this module only gathers
 * them.
 *
 * **Every one seeds `enabled: false, status: "draft"`** — ADR 0012 §1, fail closed. A tool
 * whose connector is off renders an honest "an operator has switched this source off"
 * state, makes no outbound request, and is still a complete page: the technique, the limits
 * and the worked example do not depend on a live upstream.
 *
 * Two of the four need a human decision before they are turned on, and both say so in their
 * own `legal_basis`:
 *
 *   - **crt.sh** publishes no terms of service and no rate limit at all. That gap is the
 *     weakest basis of the four and an operator has to accept it deliberately.
 *   - **RIPEstat** Art. 3.3 forbids re-packaging or redistributing the service and its data.
 *     Our reading is that answering a reader's own lookup is use rather than redistribution,
 *     but that reading is ours; written confirmation from stat@ripe.net would settle it.
 *
 * `docs/sources/<slug>.md` records each check against the six source-acceptance criteria.
 */
export const TOOLBENCH_CONNECTOR_SEEDS = [
  CRTSH_CONNECTOR_SEED,
  DNS_CONNECTOR_SEED,
  RIPESTAT_CONNECTOR_SEED,
  WAYBACK_CONNECTOR_SEED,
] as const;

export {
  CRTSH_CONNECTOR_SEED,
  DNS_CONNECTOR_SEED,
  RIPESTAT_CONNECTOR_SEED,
  WAYBACK_CONNECTOR_SEED,
};
