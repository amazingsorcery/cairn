import { createHmac } from "node:crypto";

import { lt, sql } from "drizzle-orm";

import { rateLimits, sessions, verificationTokens, connectorRequests } from "@/db/schema";
import { db as defaultDb, type Db } from "./db";
import { env } from "./env";

/**
 * Fixed-window rate limiting in Postgres (no Redis).
 *
 * `rate_limits.key` never holds a raw email or IP: it is
 * `<action>:<HMAC-SHA256(subject, RATE_LIMIT_SECRET)>`. `hashSubject` is shared with the
 * connector audit log.
 */

/** Every limited surface. */
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
 * Default policies. Fixed windows allow up to 2x the rate across a boundary; a sliding window
 * would need per-request timestamp rows, which we avoid for privacy.
 */
export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitAction, RateLimitPolicy>> = {
  /** Per recipient, against mailbombing. */
  "signin-email": { limit: 5, windowSeconds: 900 },
  /**
   * Per client, so one client can't send links to many addresses from our domain. Higher
   * than per-recipient to allow shared NATs. Both must pass.
   */
  "signin-sender": { limit: 20, windowSeconds: 900 },
  /** One indexed query per debounced keystroke, unauthenticated. */
  "search-suggest": { limit: 60, windowSeconds: 60 },
  "workspace-write": { limit: 120, windowSeconds: 60 },
  "note-write": { limit: 60, windowSeconds: 60 },
  /** PDF export runs pdfkit in-process (0.7-10.7 s per call), so a loop could DoS the box. */
  "workspace-export": { limit: 10, windowSeconds: 60 },
  /**
   * Connector counters:
   *   `connector-entry`  per client, across all connectors; consumed before the registry is
   *                      read, bounding our own work (including the refusal audit row).
   *   `connector-user`   per client per connector; limit read from the connector row.
   *   `connector-global` per connector across all clients; counts outbound calls.
   *
   * 120/min leaves room for several readers behind one NAT; a loop does thousands.
   */
  "connector-entry": { limit: 120, windowSeconds: 60 },
  /** Default per-user connector quota; real values come from `connectors`. */
  "connector-user": { limit: 30, windowSeconds: 60 },
  /** Global ceiling so we cannot breach an upstream's fair use even under load. */
  "connector-global": { limit: 600, windowSeconds: 60 },
  /**
   * `/map` and `/map/data/<layer>`, per client: unauthenticated, and each request writes to
   * `connector_requests`. Six layers on a 5 s tick is 72/min; 240 allows ~3 readers per NAT.
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
 * `HMAC-SHA256(subject, RATE_LIMIT_SECRET)` as 64 lowercase hex chars. Also used for
 * `connector_requests.actor_key`. Keyed because emails and IPv4s are small enough to
 * brute-force from a plain hash.
 */
export function hashSubject(subject: string): string {
  return createHmac("sha256", env.RATE_LIMIT_SECRET).update(subject.trim().toLowerCase()).digest(
    "hex",
  );
}

/** `<action>:<hash>`; can never contain an `@`, dotted quad or uuid. */
export function deriveKey(action: RateLimitAction, subject: string): string {
  return `${action}:${hashSubject(subject)}`;
}

/**
 * Start of the window containing `at`, aligned to the epoch so every instance and restart
 * agrees on boundaries.
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
 * Count one request and say whether it's permitted. A single upsert on `(key, window_start)`
 * avoids a read-modify-write race. Raw SQL because `onConflictDoUpdate` can't increment the
 * existing row and return it; all values are bound.
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
  // RETURNING always yields one row; fail closed if not.
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
 * `consume` that never throws and fails open: if the database is down the request fails
 * anyway. Connector quotas protect third parties, so `lib/connectors` calls `consume`
 * directly and fails closed.
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
 * Maintenance sweep of expired rate limits, sessions, verification tokens and
 * `connector_requests` (which grows with traffic). Runs nightly with `VACUUM ANALYZE`.
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
 * Rate-limit subject for an unauthenticated request. Relies on Caddy setting (not appending)
 * `X-Forwarded-For`; revisit if a CDN is added in front. Only the first entry is used, and
 * it's HMACed by `consume`. With no header, all callers share one bucket (fail closed).
 */
export function clientSubject(request: Request): string {
  return clientSubjectFromHeaders(request.headers);
}

/** Same, for Server Components that have `headers()` rather than a `Request`. */
export function clientSubjectFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown-client";
}
