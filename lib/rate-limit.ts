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
  "search-suggest",
  "workspace-write",
  "note-write",
  "connector-user",
  "connector-global",
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
  /** Each one sends an email. An open relay burns the sending domain's reputation. */
  "signin-email": { limit: 5, windowSeconds: 900 },
  /** One indexed query per debounced keystroke, unauthenticated. */
  "search-suggest": { limit: 60, windowSeconds: 60 },
  "workspace-write": { limit: 120, windowSeconds: 60 },
  "note-write": { limit: 60, windowSeconds: 60 },
  /** Per-user connector quota. The real numbers come from `connectors` (ADR 0011 rule 3). */
  "connector-user": { limit: 30, windowSeconds: 60 },
  /** Global ceiling so we cannot breach an upstream's fair use even under load. */
  "connector-global": { limit: 600, windowSeconds: 60 },
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
