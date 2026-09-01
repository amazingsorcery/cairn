import { createHmac } from "node:crypto";

import { lt, sql } from "drizzle-orm";

import { rateLimits, sessions, verificationTokens, connectorRequests } from "@/db/schema";
import { db as defaultDb, type Db } from "./db";
import { env } from "./env";

/**
 * Fixed-window rate limiting in Postgres. ADR 0009; the upsert is HANDOFF.md §5.
 *
 * There is no Redis and there will not be one: the stack is three containers on a 2 GB VPS
 * (product-brief §5). A counter does not justify a fourth stateful service.
 *
 * THE PRIVACY RULE, which is the part that is easy to get wrong:
 * `rate_limits.key` never contains a raw email address or IP. It is
 * `<action>:<HMAC-SHA256(subject, RATE_LIMIT_SECRET)>` in lowercase hex. A rate-limit table
 * keyed by plaintext identifier and action is an interest graph of exactly the audience
 * product-brief §3.2 constraint 4 exists to protect — journalists and human-rights
 * researchers. `deriveKey` below is the only place a subject is turned into a key, and
 * `hashSubject` is reused verbatim by the connector audit log (ADR 0013), so there is one
 * hashing construction in this codebase rather than two.
 */

/** Every limited surface, named once. New surfaces get a member here, not a string literal. */
export const RATE_LIMIT_ACTIONS = [
  "signin-email",
  "signin-sender",
  "search-suggest",
  "workspace-write",
  "note-write",
  "workspace-export",
  "connector-entry",
  "connector-user",
  "connector-global",
  "map-layer",
] as const;
export type RateLimitAction = (typeof RATE_LIMIT_ACTIONS)[number];

export type RateLimitPolicy = {
  /** Maximum permitted requests within one window. */
  limit: number;
  /** Window length in seconds. Windows are aligned to the epoch, not to first use. */
  windowSeconds: number;
};

/**
 * Default policies. Deliberately conservative on the two surfaces that cost real money or
 * real disk, and generous on the one a human hits by typing.
 *
 * Fixed windows permit up to 2x the nominal rate across a boundary (ADR 0009). For
 * "5 magic links per 15 minutes" the worst case is 10, which is irrelevant. A sliding
 * window would need per-request timestamp rows — the surveillance surface this design
 * exists to avoid.
 */
export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitAction, RateLimitPolicy>> = {
  /**
   * Per RECIPIENT. Protects a person from being mailbombed with links they did not ask for.
   */
  "signin-email": { limit: 5, windowSeconds: 900 },
  /**
   * Per CLIENT, and the one that actually protects the sending domain.
   *
   * `signin-email` alone does not: it is keyed on the address, so one client can request
   * links for a thousand different addresses and every one gets its own fresh bucket, while
   * every one sends mail from our domain. The policy comment above `signin-email` named that
   * exact threat — "an open relay burns the sending domain's reputation" — and the key did
   * not address it. Found by an end-to-end test that looped with a fresh address each time
   * and watched the limiter never fire.
   *
   * Higher than the per-recipient limit because a shared NAT or an office range is one
   * client to us and may hold many genuine people; low enough that enumerating addresses
   * costs real time. Both must pass.
   */
  "signin-sender": { limit: 20, windowSeconds: 900 },
  /** One indexed query per debounced keystroke, unauthenticated. */
  "search-suggest": { limit: 60, windowSeconds: 60 },
  "workspace-write": { limit: 120, windowSeconds: 60 },
  "note-write": { limit: 60, windowSeconds: 60 },
  /**
   * The most expensive path in the product. `renderCasePdf` runs pdfkit in-process on the
   * Node runtime and was measured at 0.7–10.7 s per call; the deployment target is one 2–4 GB
   * VPS running the app, Postgres and Caddy together (product-brief §5), and Caddy holds a
   * request for 30 s rather than shedding it. A signed-in user looping this is a denial of
   * service against the whole box, not just against their own session. QA finding Q-10.
   *
   * 10/minute is generous for a human exporting their own case file and ruinous for a loop.
   */
  "workspace-export": { limit: 10, windowSeconds: 60 },
  /**
   * THE DOOR TO `lib/connectors`, per client. QA finding QV-25.
   *
   * The three connector counters are not the same counter and are easy to confuse, so:
   *
   *   `connector-entry`  — per CLIENT, across every connector. Consumed on every
   *                        `runConnector` call before the registry is read. It bounds the
   *                        work an anonymous stranger can make this box do, including the
   *                        `SELECT` on `connectors` and the `INSERT` into
   *                        `connector_requests` that a refusal writes. Ours, not an
   *                        upstream's.
   *   `connector-user`   — per client per CONNECTOR, with the limit read from that
   *                        connector's row. It bounds a reader's reads of one source.
   *   `connector-global` — per CONNECTOR across all readers, and the only one of the three
   *                        that counts outbound calls, because that is what a fair-use
   *                        argument with an operator has to count.
   *
   * THE ARITHMETIC. `/live/flights` refreshes on the connector's TTL — 60 s for adsb.lol —
   * so a reader with the page open is 1/minute; a Toolbench user is a handful of lookups a
   * minute at typing speed. 120 leaves room for several readers behind one address (an
   * office range or a shared NAT is one client to us) and for a page whose viewport a reader
   * is actively moving, and is ruinous for a loop, which does thousands. It is a ceiling on
   * abuse rather than a throttle on use — the same shape and half the number as `map-layer`,
   * which polls six layers on a five-second tick.
   */
  "connector-entry": { limit: 120, windowSeconds: 60 },
  /** Per-user connector quota. The real numbers come from `connectors` (ADR 0011 rule 3). */
  "connector-user": { limit: 30, windowSeconds: 60 },
  /** Global ceiling so we cannot breach an upstream's fair use even under load. */
  "connector-global": { limit: 600, windowSeconds: 60 },
  /**
   * `/map` and `/map/data/<layer>`, per client. QA finding QV-05.
   *
   * Both were unauthenticated and unlimited, and `middleware.ts` matches only
   * `/workspaces/*` and `/admin/*`, so nothing above them counted anything. A single
   * anonymous client could drive a `SELECT` and an `INSERT` per layer per request against
   * `connector_requests` — the one table in this schema with no natural bound.
   *
   * THE ARITHMETIC. The map polls six layers on a five-second tick, which is 72 requests a
   * minute from one reader with the page open. 240 leaves room for three readers sharing one
   * address — an office range or a shared NAT is one client to us — and is ruinous for a
   * loop, which does thousands. It is a ceiling on abuse, not a throttle on use: a reader who
   * meets it is either running a script or sitting behind a very large NAT, and the surface
   * says which of our limits they met rather than blaming the sources.
   */
  "map-layer": { limit: 240, windowSeconds: 60 },
};

export type RateLimitResult = {
  ok: boolean;
  /** Requests used in this window, including the one just counted. */
  count: number;
  limit: number;
  /** Requests left before the limit bites. Never negative. */
  remaining: number;
  /** When the current window ends and the counter resets. */
  resetAt: Date;
};

/**
 * `HMAC-SHA256(subject, RATE_LIMIT_SECRET)` as 64 lowercase hex characters.
 *
 * Exported because `connector_requests.actor_key` uses the identical construction and is
 * CHECK-constrained to `^[0-9a-f]{64}$` (ADR 0013) — one function, one shape, no drift.
 *
 * HMAC rather than a bare SHA-256: the subject space (email addresses, IPv4 addresses) is
 * small enough to enumerate exhaustively, so an unkeyed digest of an IP address is an IP
 * address with extra steps. The key is what makes the value unusable to anyone who obtains
 * a database dump without also obtaining the environment.
 */
export function hashSubject(subject: string): string {
  return createHmac("sha256", env.RATE_LIMIT_SECRET).update(subject.trim().toLowerCase()).digest(
    "hex",
  );
}

/**
 * `<action>:<hash>`. The action is a member of a closed vocabulary and the hash is hex, so
 * the key is structurally incapable of containing an `@`, a dotted quad, or a uuid's
 * hyphens — which is HANDOFF §11 assertion 12, asserted here in the unit tests.
 */
export function deriveKey(action: RateLimitAction, subject: string): string {
  return `${action}:${hashSubject(subject)}`;
}

/**
 * Start of the fixed window containing `at`, aligned to the Unix epoch.
 *
 * Epoch-aligned rather than aligned to first use, because two application instances (or the
 * same instance across a restart) must compute the same window boundary for the same
 * request time — otherwise the same subject gets two counters and twice the allowance.
 */
export function windowStart(at: Date, windowSeconds: number): Date {
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`windowSeconds must be a positive integer, got ${windowSeconds}`);
  }
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/** End of that window — `windowStart + windowSeconds`, which is also `expires_at`. */
export function windowEnd(start: Date, windowSeconds: number): Date {
  return new Date(start.getTime() + windowSeconds * 1000);
}

/**
 * Count one request against `action` for `subject` and say whether it is permitted.
 *
 * ONE statement, one round trip, no read-modify-write race. The primary key
 * `(key, window_start)` does the concurrency control: two simultaneous requests serialise on
 * the same row and both read a correct value. A `SELECT` followed by an `UPDATE` would let
 * both see the same count and both pass.
 *
 * Raw SQL via the Drizzle `sql` template tag because Drizzle's `onConflictDoUpdate` cannot
 * express `SET count = rate_limits.count + 1` referencing the *existing* row and return it
 * in the same statement. Every value is bound, not interpolated.
 */
export async function consume(
  action: RateLimitAction,
  subject: string,
  options: { policy?: RateLimitPolicy; now?: Date; db?: Db } = {},
): Promise<RateLimitResult> {
  const policy = options.policy ?? RATE_LIMIT_POLICIES[action];
  const now = options.now ?? new Date();
  const client = options.db ?? defaultDb;

  const start = windowStart(now, policy.windowSeconds);
  const expires = windowEnd(start, policy.windowSeconds);
  const key = deriveKey(action, subject);

  const rows = await client.execute<{ count: number }>(sql`
    insert into ${rateLimits} (${sql.identifier("key")}, ${sql.identifier("window_start")}, ${sql.identifier("count")}, ${sql.identifier("expires_at")})
    values (${key}, ${start}, 1, ${expires})
    on conflict (${sql.identifier("key")}, ${sql.identifier("window_start")})
    do update set ${sql.identifier("count")} = ${rateLimits}.${sql.identifier("count")} + 1
    returning ${sql.identifier("count")}
  `);

  const first = rows.rows[0];
  // A RETURNING clause on an upsert always yields exactly one row. If it somehow did not,
  // failing closed is the only safe reading: an uncounted request is an uncounted request.
  const count = first ? Number(first.count) : policy.limit + 1;

  return {
    ok: count <= policy.limit,
    count,
    limit: policy.limit,
    remaining: Math.max(policy.limit - count, 0),
    resetAt: expires,
  };
}

/**
 * `consume`, but never throws. A database blip must not turn a sign-in page into a 500.
 *
 * FAIL OPEN, deliberately, and only here: if the database is unreachable the request was
 * going to fail anyway — every surface behind this limiter reads or writes the same
 * database — so failing closed buys no protection and costs a confusing error message. The
 * one place this reasoning does not hold is the connector quota, which protects a *third
 * party's* fair-use ceiling rather than ours; `lib/connectors` therefore calls `consume`
 * directly and treats an error as quota-exhausted.
 */
export async function consumeSafely(
  action: RateLimitAction,
  subject: string,
  options: { policy?: RateLimitPolicy; now?: Date; db?: Db } = {},
): Promise<RateLimitResult & { degraded: boolean }> {
  const policy = options.policy ?? RATE_LIMIT_POLICIES[action];
  try {
    return { ...(await consume(action, subject, options)), degraded: false };
  } catch (error) {
    const { logger } = await import("./logger");
    logger.error({ scope: "rate-limit", action, err: error }, "Rate limit check failed");
    const start = windowStart(options.now ?? new Date(), policy.windowSeconds);
    return {
      ok: true,
      count: 0,
      limit: policy.limit,
      remaining: policy.limit,
      resetAt: windowEnd(start, policy.windowSeconds),
      degraded: true,
    };
  }
}

export type SweepResult = {
  rateLimits: number;
  sessions: number;
  verificationTokens: number;
  connectorRequests: number;
};

/**
 * The maintenance sweep. HANDOFF §5, plus the `connector_requests` retention sweep required
 * by ADR 0013 §5 — that table grows with traffic rather than with content and is the only
 * one in the schema with no natural bound.
 *
 * Scheduled by the devops-engineer alongside the nightly `VACUUM ANALYZE`. An unswept
 * `rate_limits` is the one way ADR 0009's design degrades; an unswept `connector_requests`
 * is both a disk failure on a small VPS and a slowly accumulating record of the kind ADR
 * 0013 exists to prevent.
 */
export async function sweepExpired(
  options: { now?: Date; db?: Db } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const client = options.db ?? defaultDb;

  const [limits, sess, tokens, requests] = await Promise.all([
    client.delete(rateLimits).where(lt(rateLimits.expiresAt, now)).returning({ k: rateLimits.key }),
    client.delete(sessions).where(lt(sessions.expires, now)).returning({ k: sessions.sessionToken }),
    client
      .delete(verificationTokens)
      .where(lt(verificationTokens.expires, now))
      .returning({ k: verificationTokens.token }),
    client
      .delete(connectorRequests)
      .where(lt(connectorRequests.expiresAt, now))
      .returning({ k: connectorRequests.id }),
  ]);

  return {
    rateLimits: limits.length,
    sessions: sess.length,
    verificationTokens: tokens.length,
    connectorRequests: requests.length,
  };
}

/**
 * The rate-limit subject for an unauthenticated HTTP request.
 *
 * Caddy sets `X-Forwarded-For` with `header_up X-Forwarded-For {remote_host}` — SET, not
 * append — so a client cannot influence what the app sees (docs/deploy/HANDOFF.md A#3).
 * That guarantee holds only for as long as that Caddyfile line does; if a CDN is ever put in
 * front of Caddy, this function and that file must be revisited together.
 *
 * The first entry is taken and everything after it ignored, because a spoofed prefix is the
 * classic bypass. The value never leaves this function unhashed: it goes straight into
 * `consume`, which HMACs it before it reaches the database (ADR 0009).
 *
 * When no header is present — a direct request to `web:3000` inside the Compose network, or
 * a local `next dev` — the subject falls back to a constant. That means every such caller
 * shares one counter, which is the correct fail-closed behaviour: it cannot be used to
 * bypass a limit, only to hit one sooner.
 */
export function clientSubject(request: Request): string {
  return clientSubjectFromHeaders(request.headers);
}

/**
 * The same, for a Server Component, which is handed `headers()` rather than a `Request`.
 *
 * One implementation, because "take the first entry and ignore the rest" is the security
 * property and a second copy of it is a second place for it to be got wrong.
 */
export function clientSubjectFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown-client";
}
