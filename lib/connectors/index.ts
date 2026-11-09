/**
 * The connector seam: the only place outbound requests on a user's behalf live. Each
 * connector has a registry row (operator, terms, attribution, quotas, kill switch) and every
 * call is audit-logged.
 *
 *   types.ts    interface and degraded-result vocabulary
 *   runtime.ts  registry -> kill-switch -> global ceiling -> per-user quota -> timeout ->
 *               audit -> envelope
 *   audit.ts    outbound log (hashed actor, no request content)
 *   flights.ts  ADS-B driver
 *
 * To add a connector: implement `ConnectorDriver` and add a `connectors` row with
 * `terms_url`, `legal_basis` and `last_checked_at` (required by the DB to publish).
 *
 * Cameras have no driver: embeds are click-to-load from the reader's browser. Their registry
 * rows only carry the legal basis that `cameras_embed_requires_connector_check` requires.
 */
export * from "./types";
export {
  runConnector,
  UpstreamStatusError,
  isRateLimitStatus,
  parseRetryAfter,
  cooldownRemaining,
  openCooldown,
  DEFAULT_COOLDOWN_SECONDS,
  type RunOptions,
} from "./runtime";
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
