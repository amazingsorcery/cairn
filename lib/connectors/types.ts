import type { Connector, ConnectorKind } from "@/db/schema";

/**
 * The connector seam. ADR 0011 §3.3 and ADR 0014.
 *
 * `lib/connectors/` is the SINGLE place any outbound request on a user's behalf may live.
 * Everything in here is server-only and must never be reachable from the browser: a direct
 * client fetch would hand the user's IP and their query pattern — the patch of the world
 * they are looking at — to a third party, which is exactly the interest-graph leak
 * product-brief §3.2 constraint 4 exists to prevent.
 */

/**
 * The envelope every connector returns. ADR 0014 §1: **freshness travels inside the
 * payload, not in cache metadata.**
 *
 * `fetchedAt` is stamped at the moment of the upstream response and is cached WITH the data,
 * so the UI can compute the age on every render and tick regardless of which cache layer
 * served it, how long the payload sat there, or whether the page came back from bfcache.
 * That is the one number on a Live page that must never be wrong.
 */
export type ConnectorEnvelope<T> = {
  /** When the upstream actually answered. Null when no payload was ever obtained. */
  fetchedAt: Date | null;
  state: ConnectorState;
  data: T | null;
  connectorSlug: string;
  /** Rendered next to the data, never in a footer (ADR 0011 rule 2). */
  attribution: string | null;
  /**
   * Why the surface is degraded, in one sentence fit to render. Never an upstream error
   * body, a stack, or a URL. Null when `state` is `fresh`.
   */
  lastError: string | null;
  /** Distinguishes the four degraded states so the UI can say what is wrong. ADR 0011 rule 5. */
  reason: DegradedReason | null;
};

export type ConnectorState = "fresh" | "stale" | "unavailable";

/**
 * ADR 0011 rule 5 requires the UI to state WHAT is wrong and HOW OLD the data is. "It broke"
 * is not a state; these four are, and they need different copy:
 *
 *  - `upstream-down`    — we called and it failed or timed out. Try again shortly.
 *  - `stale`            — we have data past its TTL and revalidation has not yet succeeded.
 *  - `quota-exhausted`  — a refusal we made, per-user or global. Nothing left the building.
 *  - `rate-limited`     — a refusal THEY made: 429 or 420. Distinct from every other reason
 *                         because it is the only one where continuing to call is a breach of
 *                         product-brief §3.2 constraint 5, not merely futile. The client MUST
 *                         stop polling on this reason (see `lib/connectors/runtime.ts`).
 *  - `disabled`         — an operator turned the kill-switch off, or the connector has no
 *                         recorded legal basis. Not a fault; a decision.
 *  - `bad-request`      — WE refused the caller's parameters before calling anyone. Nothing
 *                         left the building and nothing is wrong upstream.
 *
 * `bad-request` was added because a grammar failure was reporting `upstream-down`: the right
 * sentence ("that request could not be understood") attached to the wrong reason. Every
 * surface that branches on `reason` therefore told the reader a third party was having a bad
 * day when the truth was that we had rejected what they typed — and on the Toolbench, where a
 * user supplies the parameters, that is the difference between "fix your input" and "try
 * again later". It is also the difference between an operator seeing a spike of upstream
 * failures and seeing a spike of malformed requests, which lead to opposite investigations.
 */
export type DegradedReason =
  | "upstream-down"
  | "stale"
  | "quota-exhausted"
  | "rate-limited"
  | "disabled"
  | "bad-request";

/**
 * A connector NEVER throws for an expected failure. It returns a degraded envelope.
 *
 * This is not stylistic. ADR 0011 rule 5 requires every Live surface to have a real
 * upstream-down and stale state that says what is wrong and how old the data is — "never a
 * spinner that lies". A thrown error becomes an error boundary, which is a page that says
 * nothing useful and loses the age of the last good payload along with everything else.
 */
export type ConnectorDriver<Params, Result> = {
  kind: ConnectorKind;
  /** Must match `connectors.slug` in the registry. */
  slug: string;
  /**
   * Normalise request parameters into a stable, bounded shape. Two jobs: it is the cache
   * key (ADR 0014 §4 — one shared entry per connector plus normalised params, NEVER per
   * user), and it is the clamp that stops a crafted request from asking an upstream for
   * something outside its documented limits.
   */
  normalise: (raw: unknown) => Params;
  /** A stable string for the normalised params. Must not encode anything about the caller. */
  cacheKey: (params: Params) => string;
  /**
   * Make the call. Receives an `AbortSignal` already armed with the connector's
   * `timeout_ms`. Returns the trimmed payload — ADR 0014 §7: only the fields the surface
   * renders, so a Data Cache entry rewritten every 15 seconds stays small, and so we are not
   * incidentally holding upstream fields we have no use for.
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
