import type { Connector, ConnectorKind } from "@/db/schema";

/**
 * The connector seam: the only place outbound requests on a user's behalf live. Server-only;
 * a browser fetch would expose the user's IP and query to a third party.
 */

/**
 * The envelope every connector returns. Freshness travels in the payload: `fetchedAt` is
 * cached with the data, so the UI can compute age regardless of which cache served it.
 */
export type ConnectorEnvelope<T> = {
  /** When the upstream actually answered. Null when no payload was ever obtained. */
  fetchedAt: Date | null;
  state: ConnectorState;
  data: T | null;
  connectorSlug: string;
  /** Rendered next to the data, never in a footer. */
  attribution: string | null;
  /**
   * Why the surface is degraded, in one sentence fit to render. Never an upstream error
   * body, a stack, or a URL. Null when `state` is `fresh`.
   */
  lastError: string | null;
  /** Which degraded state, so the UI can say what is wrong. */
  reason: DegradedReason | null;
  /**
   * With `quota-exhausted` only: the refusing limiter's own `resetAt` (used for
   * `Retry-After`). Same for every caller in the window, so it leaks nothing.
   */
  quotaResetsAt: Date | null;
  /**
   * With `quota-exhausted` only: which counter refused, so the UI names the right limit
   * without parsing `lastError`.
   */
  quotaScope: QuotaScope | null;
};

/**
 * Which counter refused:
 *  - `entry`      our per-client counter across all live sources; no upstream involved.
 *  - `viewer`     this caller's quota for this connector (`per_user_quota`).
 *  - `shared`     the connector's global ceiling, protecting the upstream's fair-use limit.
 *  - `unmeasured` a counter couldn't be read and we failed closed.
 */
export type QuotaScope = "entry" | "viewer" | "shared" | "unmeasured";

export type ConnectorState = "fresh" | "stale" | "unavailable";

/**
 * Degraded reasons, each with different UI copy:
 *  - `upstream-down`    we called and it failed or timed out.
 *  - `stale`            data past its TTL; revalidation hasn't succeeded yet.
 *  - `quota-exhausted`  we refused (see `quotaScope`); no request made.
 *  - `rate-limited`     upstream returned 429/420. The client must stop polling.
 *  - `disabled`         kill switch off, or no recorded legal basis.
 *  - `bad-request`      we rejected the caller's parameters; nothing wrong upstream.
 */
export type DegradedReason =
  | "upstream-down"
  | "stale"
  | "quota-exhausted"
  | "rate-limited"
  | "disabled"
  | "bad-request";

/**
 * Expected failures return a degraded envelope rather than throwing, so the surface keeps
 * the last good payload and its age instead of hitting an error boundary.
 */
export type ConnectorDriver<Params, Result> = {
  kind: ConnectorKind;
  /** Must match `connectors.slug` in the registry. */
  slug: string;
  /**
   * Normalise params into a stable, bounded shape: the basis of the shared cache key (never
   * per user) and the clamp to the upstream's documented limits.
   */
  normalise: (raw: unknown) => Params;
  /** A stable string for the normalised params. Must not encode anything about the caller. */
  cacheKey: (params: Params) => string;
  /*
   * No `perActor` opt-out: a free cache read would reveal whether someone else asked the same
   * question, and a driver can't know whether its call sites pass user input. `runConnector`
   * charges quota before every cache read and quantises `fetchedAt`, for all drivers
   * (asserted by `tests/security/flights-oracle.test.ts`).
   */
  /**
   * Make the call. `signal` is armed with `timeout_ms`. Return only the fields the surface
   * renders.
   */
  fetch: (
    connector: Connector,
    params: Params,
    signal: AbortSignal,
  ) => Promise<{ data: Result; upstreamStatus: number }>;
};

/** What the caller supplies about who is asking. Hashed before it reaches the database. */
export type ActorIdentity = {
  /** A session user id, or the client IP for an anonymous caller. Never stored raw. */
  subject: string;
};
