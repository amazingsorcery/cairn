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
  /**
   * When the counter that refused this caller next resets, or null.
   *
   * Non-null only alongside `reason: "quota-exhausted"`, and it is the limiter's OWN
   * `resetAt` rather than a number recomputed from a window length — whichever of the three
   * counters refused (the entry limiter, the per-user quota, the global ceiling) is the one
   * that answers, and none of them has to agree with the others about window size.
   *
   * It exists because two surfaces were deriving it independently: `/api/live/flights` needs
   * it for a `Retry-After` header and `/live/flights/page.tsx` was recomputing it from
   * `connectors.window_seconds` with its own copy of the epoch-alignment arithmetic. Two
   * copies of one calculation is how they come to disagree, which is the failure this whole
   * audit round is about.
   *
   * It leaks nothing: a fixed window boundary is a pure function of the clock and the policy,
   * identical for every caller in that window.
   */
  quotaResetsAt: Date | null;
  /**
   * WHICH counter refused, alongside `quota-exhausted`. Null for every other reason.
   *
   * QA finding QV-29. `reason` says a quota refused the call and three different quotas can
   * be the one that did; the surface has to name the right one, because the sentences are
   * not interchangeable. "The shared ceiling that keeps us inside an operator's fair use is
   * reached" is a claim about a NAMED THIRD PARTY, and it was being rendered for refusals
   * that came from our own per-client door counter, before the registry row was even read
   * and with nothing asked of the operator at all.
   *
   * The client used to recover this by matching the first four words of `lastError`
   * (`message.startsWith("You have reached")`). That is a coupling to prose: the entry
   * limiter says "You have made", so every entry refusal fell through to the branch that
   * blames the operator. Matching a different prefix would be the same defect one word
   * later, so the discriminator travels as data.
   */
  quotaScope: QuotaScope | null;
};

/**
 * The three counters in front of an upstream, plus the state where we could not read one.
 *
 * They are genuinely different facts and they lead a reader — and an operator — to different
 * conclusions, which is why they are not collapsed:
 *
 *  - `entry`      — OUR per-client door counter (`connector-entry`), spanning every live
 *                   source. It refuses before the registry read, so no request was made and
 *                   no upstream was involved in any way.
 *  - `viewer`     — this caller's own quota for this connector (`connector-user`), the number
 *                   an operator sets in `connectors.per_user_quota`.
 *  - `shared`     — the connector's global ceiling (`connector-global`), which exists to keep
 *                   every reader combined inside the upstream's fair-use limit. This is the
 *                   ONLY one of the three where an upstream's limit is even part of the story.
 *  - `unmeasured` — a counter could not be read and we refused fail-closed. We do not know
 *                   which limit stands or when it clears, and saying either would be a guess.
 */
export type QuotaScope = "entry" | "viewer" | "shared" | "unmeasured";

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
   * THERE IS NO `perActor` FLAG, AND ITS ABSENCE IS THE CONTROL. QA finding QV-02, twice.
   *
   * ADR 0014 §4 says the payload cache holds one shared entry per connector plus normalised
   * params and never a per-user one. That is right, and it is unchanged: keying the entry by
   * actor would make the upstream see one call per reader and would put the interest graph
   * into the key. What was wrong was that a READ of that entry was free. On the Toolbench the
   * cache key *is* the reader's question — a domain, an IP, a URL, an Overpass query — so a
   * stranger could ask this deployment "has anybody here looked up X recently?" and get a
   * reliable yes/no plus the other reader's fetch instant, leaving no trace. ADR 0013 scrubs
   * the query from the audit log precisely so a journalist's lookups cannot be reconstructed
   * from our records; a cache that answers the same question in plaintext undoes that.
   *
   * The first fix added `perActor: boolean` to this type so a driver could declare which kind
   * of question it asks. Seven drivers declared `true`. `flightsDriver` declared `false`,
   * reasoning that "a viewport is a question about the world rather than about the reader" —
   * true of `/map`, which does not use that driver, and false of `/live/flights`, which is a
   * search-by-place surface where the reader types the coordinates. QA measured the result: a
   * victim's exact millisecond returned to an attacker four times, free, unaudited and
   * unlimited, from a GET over an 11 km grid.
   *
   * **Whether a cache key holds caller-supplied input is a fact about the CALL SITE, and a
   * driver cannot see its call sites.** A boolean here is a claim about every present and
   * future caller, made in the one file that has no way to check it. So there is nothing to
   * declare: `runConnector` spends the caller's quota before it reads the cache and quantises
   * `fetchedAt` down to the connector's cache window on the way out, for every driver and
   * every surface. A new driver cannot opt out, because there is no opt-out to write.
   *
   * `tests/security/flights-oracle.test.ts` asserts that this stays true — that no file in
   * `lib/connectors/` sets such a flag and that the quota is spent above the cache read.
   */
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
