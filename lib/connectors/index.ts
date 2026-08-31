/**
 * The connector seam. product-brief §3.3, ADR 0011.
 *
 * "`lib/connectors/` is the single place any outbound request on a user's behalf may live.
 * Every connector must declare, in the registry: its operator, the licence or terms that
 * permit our use, the attribution we must render, its per-user quota and global ceiling, and
 * its kill-switch state. Every outbound query is audit-logged."
 *
 * The shape of that, in this directory:
 *
 *   types.ts    the uniform interface and the degraded-result vocabulary
 *   runtime.ts  the one path a call takes: registry -> kill-switch -> global ceiling ->
 *               per-user quota -> timeout -> audit -> envelope
 *   audit.ts    the outbound log, with a hashed actor and no request content (ADR 0013)
 *   flights.ts  the ADS-B driver, with what was confirmed about it and when
 *
 * ADDING A CONNECTOR is: a driver implementing `ConnectorDriver`, plus a row in the
 * `connectors` table carrying a real `terms_url`, `legal_basis` and `last_checked_at` —
 * which the database will refuse to publish without (ADR 0012). There is no other way in,
 * and that is the design.
 *
 * The CAMERAS surface has no driver and needs none: `/live/cameras` renders our own registry
 * rows and makes zero outbound requests on load. Embeds are click-to-load, from the
 * reader's own browser, to the operator directly (ADR 0015). The camera connectors exist in
 * the registry to carry the recorded legal basis that embedding requires
 * (`cameras_embed_requires_connector_check`), not to be called.
 */
export * from "./types";
export { runConnector, UpstreamStatusError, type RunOptions } from "./runtime";
export { recordConnectorRequest, AUDIT_RETENTION_DAYS, type AuditEntry } from "./audit";
export {
  flightsDriver,
  flightParamsSchema,
  FLIGHTS_CONNECTOR_SLUG,
  FLIGHTS_CONNECTOR_SEED,
  type Aircraft,
  type FlightParams,
  type FlightsPayload,
} from "./flights";
