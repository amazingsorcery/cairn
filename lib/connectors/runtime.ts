import type { Connector } from "@/db/schema";
import { logger } from "@/lib/logger";
import { getConnectorBySlug } from "@/lib/queries/live";
import { isLive, notLiveReason } from "./liveness";
import { tallyOutbound } from "@/lib/net/outbound-tally";
import { consume } from "@/lib/rate-limit";
import { recordConnectorRequest } from "./audit";
import { e2eOverride } from "./e2e-override";
import type { ActorIdentity, ConnectorDriver, ConnectorEnvelope, QuotaScope } from "./types";

/**
 * The one path an outbound call takes. Server-only (guarded below, since `server-only` isn't
 * a dependency): in a browser it would leak the user's IP and viewport to the upstream.
 *
 * Order of checks:
 *   0. entry budget     one `connector-entry` unit per call, before the registry read. Lives
 *                       here because every entry point passes through this function.
 *   1. registry         published, enabled, with a legal basis (kill switch). A refusal memo
 *                       avoids re-reading and re-auditing a disabled connector per request.
 *   1b. per-user quota  for every driver, before the cache read, so a cache hit can't be
 *                       used to learn what other readers looked up.
 *   2. cache            fresh entries are served without an upstream call.
 *   3. global ceiling   spent only on an actual call, so it counts outbound requests.
 *   4. the call         with an AbortSignal at `timeout_ms`.
 *
 * Everything is audited, including refusals, except cache hits, remembered refusals and
 * entry-budget denials.
 *
 * Expected failures never throw; they return a degraded envelope saying what's wrong and how
 * old the data is.
 */

/** jsdom defines `window` but still has `process`, so check both. */
const IN_BROWSER =
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof process === "undefined";

if (IN_BROWSER) {
  throw new Error(
    "lib/connectors is server-only. Importing it into a Client Component would send the " +
      "user's IP and viewport straight to the upstream. Call it " +
      "from a Route Handler or a Server Component instead.",
  );
}

/** Shared in-process payload cache. */
type CacheEntry = { fetchedAt: Date; payload: unknown };

/**
 * Payloads live only here, never in a table. Bounded, keyed by connector + normalised params
 * (never by user), max lifetime `ttl + swr`.
 *
 * A plain Map rather than `unstable_cache` so `fetchedAt` is the real upstream response time,
 * not a second cache's clock. Lost on restart, which costs one cold fetch.
 */
const globalForCache = globalThis as typeof globalThis & {
  __cairnConnectorCache__?: Map<string, CacheEntry>;
};
const payloadCache: Map<string, CacheEntry> = (globalForCache.__cairnConnectorCache__ ??=
  new Map());

/** Hard cap on cache entries (oldest-first eviction). */
const MAX_CACHE_ENTRIES = 512;

/**
 * Per-connector cap, so one connector can't evict everyone else's entries. Each connector
 * evicts its own oldest first; the global cap stays as a backstop.
 */
const MAX_ENTRIES_PER_CONNECTOR = 64;

function readCache(key: string): CacheEntry | undefined {
  return payloadCache.get(key);
}

/** Oldest key belonging to this connector, or undefined. `Map` iterates in insertion order. */
function oldestKeyFor(slug: string): string | undefined {
  const prefix = `${slug}:`;
  let count = 0;
  let oldest: string | undefined;
  for (const key of payloadCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    count += 1;
    oldest ??= key;
  }
  return count >= MAX_ENTRIES_PER_CONNECTOR ? oldest : undefined;
}

function writeCache(slug: string, key: string, entry: CacheEntry): void {
  if (!payloadCache.has(key)) {
    const ownOldest = oldestKeyFor(slug);
    if (ownOldest !== undefined) payloadCache.delete(ownOldest);
    if (payloadCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = payloadCache.keys().next();
      if (!oldest.done) payloadCache.delete(oldest.value);
    }
  }
  payloadCache.set(key, entry);
}

/* ------------------------------------------------------------------ *
 * Refusal memo
 * ------------------------------------------------------------------ */

/**
 * A refusal already computed and audited, so anonymous requests to a disabled connector don't
 * each cost a registry read and an audit row.
 *
 * Only refusals are remembered, so switching a source off bites immediately; re-enabling
 * waits at most `min(cache_ttl_seconds, 60)` seconds. The remembered envelope is identical to
 * the first one, so it doesn't reveal whether someone else just asked.
 */
type RememberedRefusal = { until: number; envelope: ConnectorEnvelope<never> };

const globalForRefusal = globalThis as typeof globalThis & {
  __cairnConnectorRefusalMemo__?: Map<string, RememberedRefusal>;
};
const refusalMemo: Map<string, RememberedRefusal> = (globalForRefusal.__cairnConnectorRefusalMemo__ ??=
  new Map());

/** Max seconds a refusal is remembered. */
const MAX_REFUSAL_MEMO_SECONDS = 60;

function rememberRefusal(
  slug: string,
  envelope: ConnectorEnvelope<never>,
  ttlSeconds: number,
  now: Date,
): void {
  const seconds = Math.max(1, Math.min(ttlSeconds, MAX_REFUSAL_MEMO_SECONDS));
  refusalMemo.set(slug, { until: now.getTime() + seconds * 1000, envelope });
}

function recallRefusal(slug: string, now: Date): RememberedRefusal | null {
  const entry = refusalMemo.get(slug);
  if (!entry) return null;
  if (entry.until <= now.getTime()) {
    refusalMemo.delete(slug);
    return null;
  }
  return entry;
}

/**
 * Forget every remembered refusal. Called by the admin kill switch (so re-enabling is
 * immediate in this process) and by tests.
 */
export function clearRefusalMemo(): void {
  refusalMemo.clear();
}

/* ------------------------------------------------------------------ *
 * Upstream backoff
 * ------------------------------------------------------------------ */

/**
 * Per-connector cooldown: when we may call this upstream again. Our quotas are only a
 * ceiling; on a 429/420 we stop for `Retry-After`, or `DEFAULT_COOLDOWN_SECONDS` if absent.
 * In-process; a restart costs one probe request.
 */
const globalForCooldown = globalThis as typeof globalThis & {
  __cairnConnectorCooldown__?: Map<string, Date>;
};
const cooldownUntil: Map<string, Date> = (globalForCooldown.__cairnConnectorCooldown__ ??=
  new Map());

/**
 * Used when a 429 has no `Retry-After` (adsb.lol never sends one). At least one window, since
 * backing off for less would re-enter the burst.
 */
export const DEFAULT_COOLDOWN_SECONDS = 60;

/** Seconds remaining on this connector's cooldown, or 0 when it may call. */
export function cooldownRemaining(slug: string, now: Date = new Date()): number {
  const until = cooldownUntil.get(slug);
  if (!until) return 0;
  const remaining = Math.ceil((until.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) {
    cooldownUntil.delete(slug);
    return 0;
  }
  return remaining;
}

/** Open (or extend) a cooldown. Never shortens one already running. */
export function openCooldown(slug: string, seconds: number, now: Date = new Date()): Date {
  const until = new Date(now.getTime() + Math.max(1, seconds) * 1000);
  const existing = cooldownUntil.get(slug);
  const effective = existing && existing > until ? existing : until;
  cooldownUntil.set(slug, effective);
  return effective;
}

/** Test seam. Not exported from the package index. */
export function clearCooldowns(): void {
  cooldownUntil.clear();
}

/** Age of a payload in seconds, from the timestamp stamped at the upstream response. */
function ageSeconds(fetchedAt: Date, now: Date): number {
  return (now.getTime() - fetchedAt.getTime()) / 1000;
}

/**
 * The fetch time reported to callers, rounded down to the epoch-aligned cache window. The
 * exact time would reveal when another reader made the request.
 *
 * Rounded down so data never looks younger than it is, and applied to fresh fetches too so
 * exact vs rounded doesn't distinguish a miss from a hit. Applies to all connectors.
 *
 * Known residual: an entry from the end of one window can still be served in the next, so a
 * hit may report the previous window start while a miss reports the current one (one bit at
 * window granularity).
 */
function quantiseInstant(at: Date, windowSeconds: number): Date {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return at;
  const ms = Math.floor(windowSeconds) * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

function unavailable<T>(
  slug: string,
  reason: NonNullable<ConnectorEnvelope<T>["reason"]>,
  message: string,
  attribution: string | null = null,
  fetchedAt: Date | null = null,
  /**
   * With `quota-exhausted` only: the limiter's own `resetAt`. Null if the limiter failed
   * (we don't know when it clears).
   */
  quotaResetsAt: Date | null = null,
  /** With `quota-exhausted` only: which counter refused, so the UI names the right limit. */
  quotaScope: QuotaScope | null = null,
): ConnectorEnvelope<T> {
  return {
    fetchedAt,
    state: "unavailable",
    data: null,
    connectorSlug: slug,
    attribution,
    lastError: message,
    reason,
    quotaResetsAt,
    quotaScope,
  };
}

export type RunOptions = {
  /** Overrides the registry lookup. Used by tests and by the admin "test this connector". */
  connector?: Connector;
  now?: Date;
};

export async function runConnector<Params, Result>(
  driver: ConnectorDriver<Params, Result>,
  rawParams: unknown,
  actor: ActorIdentity,
  options: RunOptions = {},
): Promise<ConnectorEnvelope<Result>> {
  const now = options.now ?? new Date();

  /* 0. The entry budget --------------------------------------------- */

  /**
   * One unit per call, per client, before any DB access. Here rather than at each entry
   * point because every path to a driver goes through `runConnector`
   * (`tests/security/connector-entry-points.test.ts` checks this).
   *
   * Fails open: it protects our own box, and everything behind it needs the same DB anyway.
   * The connector quotas below fail closed because they protect a third party's limit.
   */
  let entryAllowed = true;
  let entryKnownResetAt: Date | null = null;
  try {
    const entry = await consume("connector-entry", actor.subject, { now });
    entryAllowed = entry.ok !== false;
    entryKnownResetAt = entry.resetAt ?? null;
  } catch (error) {
    logger.error(
      { scope: "connector.run", slug: driver.slug, err: error },
      "Entry rate limit check failed; allowing the request",
    );
  }
  if (!entryAllowed) {
    logger.warn(
      { scope: "connector.run", slug: driver.slug, resetsAt: entryKnownResetAt?.toISOString() ?? null },
      "Refused before reading the registry: caller is over the connector entry limit",
    );
    // No audit row: this limiter exists to bound writes to that table. The refusal is the
    // same whatever was asked, so it reveals nothing about the cache.
    return unavailable(
      driver.slug,
      "quota-exhausted",
      "You have made too many requests to our live sources. Try again shortly.",
      null,
      null,
      entryKnownResetAt,
      // Our own limit, not an upstream's; the UI must not blame the operator.
      "entry",
    );
  }

  /* 1. Registry, kill-switch and legal basis ------------------------- */

  // Remembered refusal: no registry read, no audit row. Skipped when the caller supplies a
  // row (admin "test this connector"), which must be judged on the row given.
  const remembered = options.connector ? null : recallRefusal(driver.slug, now);
  if (remembered) return remembered.envelope as ConnectorEnvelope<Result>;

  // Resolve by slug, never by kind: several connectors share a kind, and the wrong row means
  // the wrong host, quota and legal basis.
  const connector = options.connector ?? (await getConnectorBySlug(driver.slug));

  /*
   * Test-only state override (`./e2e-override.ts`; never in production). After the registry
   * read so it can use the real attribution, but before the liveness check so it works on
   * seeded-disabled connectors. Replaces the whole call: no cache, quota, audit or request.
   */
  const forcedState = e2eOverride<Result>(
    connector?.slug ?? driver.slug,
    connector?.attribution ?? null,
    now,
  );
  if (forcedState) {
    logger.info(
      { scope: "connector.run", slug: forcedState.connectorSlug, reason: forcedState.reason },
      "State forced by E2E_CONNECTOR_STATE; no outbound call made",
    );
    return forcedState;
  }

  /*
   * Kill switch. `getConnectorBySlug` returns rows in any state, so liveness must be checked
   * here. Use the shared `isLive`; don't re-express it.
   */
  if (connector === null || !isLive(connector)) {
    const reason = notLiveReason(connector, driver.slug);
    logger.info(
      { scope: "connector.run", slug: driver.slug, reason },
      "Refused before calling upstream: connector is not live",
    );
    // Audit the refusal so "did we stop calling them?" has a positive answer.
    if (connector !== null) {
      await recordConnectorRequest({
        connectorId: connector.id,
        outcome: "disabled",
        durationMs: 0,
        upstreamStatus: null,
        upstreamRequests: 0,
        subject: actor.subject,
        at: now,
      });
    }
    const envelope = unavailable<never>(
      driver.slug,
      "disabled",
      `This live source is switched off — ${reason}. No request was made.`,
    );
    // Remember for up to min(ttl, 60)s; not for a caller-supplied row.
    if (!options.connector) {
      rememberRefusal(
        driver.slug,
        envelope,
        connector?.cacheTtlSeconds ?? MAX_REFUSAL_MEMO_SECONDS,
        now,
      );
    }
    return envelope as ConnectorEnvelope<Result>;
  }

  /**
   * Carried in the envelope so the UI renders it next to the data. Non-null whenever required
   * (`connectors_attribution_check`).
   */
  const attribution = connector.attribution;

  let params: Params;
  try {
    params = driver.normalise(rawParams);
  } catch (error) {
    /*
     * Rejected locally: no call, no audit row. `bad-request` (not `upstream-down`) so the UI
     * says "fix your input". The Zod error is logged but not returned, since it may quote
     * the reader's query.
     */
    logger.warn({ scope: "connector.run", slug: connector.slug, err: error }, "Bad parameters");
    return unavailable(
      connector.slug,
      "bad-request",
      "That request could not be understood, so nothing was requested from the source.",
      attribution,
    );
  }

  /*
   * Shared quota spend. Uses `consume` (fails closed), not `consumeSafely` (fails open): an
   * uncounted call against a third party's limit isn't acceptable. On denial, records the
   * counter's own `resetAt`; null if the counter was unreachable.
   */
  let quotaResetsAt: Date | null = null;
  const spendQuota = async (
    action: "connector-user" | "connector-global",
    subject: string,
    policy: { limit: number; windowSeconds: number },
  ): Promise<"ok" | "denied" | "unmeasurable"> => {
    try {
      const result = await consume(action, subject, { policy, now });
      if (!result.ok) quotaResetsAt = result.resetAt ?? null;
      return result.ok ? "ok" : "denied";
    } catch (error) {
      logger.error(
        { scope: "connector.run", slug: connector.slug, action, err: error },
        "Quota check failed",
      );
      quotaResetsAt = null;
      return "unmeasurable";
    }
  };

  const auditQuotaDenied = async (): Promise<void> => {
    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "quotaDenied",
      durationMs: 0,
      upstreamStatus: null,
      upstreamRequests: 0,
      subject: actor.subject,
      at: now,
    });
  };

  const userPolicy = { limit: connector.perUserQuota, windowSeconds: connector.windowSeconds };

  /* 1b. The caller's quota, BEFORE the cache is read ----------------- */

  /**
   * The cache key is the caller's question, so a free cache read would reveal whether anyone
   * else asked it recently. Charging every read closes that while keeping the shared entry.
   *
   * Unconditional, with no per-driver exemption (a driver can't know its call sites).
   * Nothing is served on denial, not even stale data, so a spent caller gets the same refusal
   * whether or not the entry exists.
   */
  const spent = await spendQuota(
    "connector-user",
    `${connector.slug}:${actor.subject}`,
    userPolicy,
  );
  if (spent !== "ok") {
    await auditQuotaDenied();
    return unavailable(
      connector.slug,
      "quota-exhausted",
      spent === "denied"
        ? "You have reached this source's request limit. Try again shortly."
        : "This live source is temporarily unavailable.",
      attribution,
      null,
      quotaResetsAt,
      // `unmeasurable` means we couldn't read the counter, not that a limit was hit.
      spent === "denied" ? "viewer" : "unmeasured",
    );
  }

  const key = `${connector.slug}:${driver.cacheKey(params)}`;
  const cached = readCache(key);

  /** Fetch time as reported to the caller; see `quantiseInstant`. */
  const outwardInstant = (at: Date): Date => quantiseInstant(at, connector.cacheTtlSeconds);

  /* 2. Serve from cache while fresh ---------------------------------- */

  // No audit row for a hit: it isn't an outbound attempt.
  if (cached && ageSeconds(cached.fetchedAt, now) <= connector.cacheTtlSeconds) {
    return {
      fetchedAt: outwardInstant(cached.fetchedAt),
      state: "fresh",
      data: cached.payload as Result,
      connectorSlug: connector.slug,
      attribution,
      lastError: null,
      reason: null,
      quotaResetsAt: null,
      quotaScope: null,
    };
  }

  /** Fallback if the refresh fails. Past `ttl + swr` we show nothing rather than old data. */
  const staleUsable =
    cached &&
    ageSeconds(cached.fetchedAt, now) <=
      connector.cacheTtlSeconds + connector.staleWhileRevalidateSeconds
      ? cached
      : undefined;

  const degradeToStale = (message: string): ConnectorEnvelope<Result> => {
    if (!staleUsable) {
      return unavailable(
        connector.slug,
        "upstream-down",
        message,
        attribution,
        cached ? outwardInstant(cached.fetchedAt) : null,
      );
    }
    return {
      fetchedAt: outwardInstant(staleUsable.fetchedAt),
      state: "stale",
      data: staleUsable.payload as Result,
      connectorSlug: connector.slug,
      attribution,
      lastError: message,
      reason: "stale",
      quotaResetsAt: null,
      quotaScope: null,
    };
  };

  /* 2b. Upstream backoff — do not call a service that told us to stop ---- */

  /**
   * Checked before the global ceiling: if the upstream asked us to back off, our own quota
   * can't authorise a call. Stale data still serves; otherwise `rate-limited` tells the
   * client to stop polling.
   */
  const cooling = cooldownRemaining(connector.slug, now);
  if (cooling > 0) {
    // `rateLimited`, not `quotaDenied`: the upstream refused us, not our own ceiling. The 429
    // that opened the cooldown is its own row with the real status.
    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "rateLimited",
      durationMs: 0,
      upstreamStatus: null,
      upstreamRequests: 0,
      subject: actor.subject,
      at: now,
    });

    const message = `This source asked us to slow down. Waiting ${cooling}s before trying again.`;
    return staleUsable
      ? {
          fetchedAt: outwardInstant(staleUsable.fetchedAt),
          state: "stale",
          data: staleUsable.payload as Result,
          connectorSlug: connector.slug,
          attribution,
          lastError: message,
          reason: "rate-limited",
          quotaResetsAt: null,
          quotaScope: null,
        }
      : unavailable(
          connector.slug,
          "rate-limited",
          message,
          attribution,
          cached ? outwardInstant(cached.fetchedAt) : null,
        );
  }

  /* 3. Quotas -------------------------------------------------------- */

  /**
   * Global ceiling: protects the upstream's fair-use limit across all users. Subject is the
   * connector slug. Spent after the cache so it counts only outbound calls.
   */
  const globalPolicy = { limit: connector.globalCeiling, windowSeconds: connector.windowSeconds };

  const global = await spendQuota("connector-global", connector.slug, globalPolicy);
  if (global !== "ok") {
    await auditQuotaDenied();
    // Fail CLOSED on `unmeasurable`: we could not prove we are inside the ceiling.
    const message =
      global === "denied"
        ? "This source is at its shared rate limit"
        : "Rate limiting is unavailable";
    return staleUsable
      ? degradeToStale(`${message}; showing the last data we have.`)
      : unavailable(
          connector.slug,
          "quota-exhausted",
          global === "denied"
            ? "This source is at its shared rate limit. Try again shortly."
            : "This live source is temporarily unavailable.",
          attribution,
          null,
          quotaResetsAt,
          // The only counter tied to the upstream's fair-use limit.
          global === "denied" ? "shared" : "unmeasured",
        );
  }

  // The per-user quota was already spent at 1b (it counts reads); don't charge it twice.

  /* 4. The call ------------------------------------------------------ */

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connector.timeoutMs);
  const started = Date.now();

  // Count outbound requests at `fetch` (drivers fan out), for the audit row.
  const attempt = await tallyOutbound(() =>
    driver.fetch(connector, params, controller.signal),
  );

  // At least 1 for an attempt, in case a driver bypassed the tally.
  const outboundRequests = Math.max(1, attempt.outboundRequests);

  try {
    if (!attempt.ok) throw attempt.error;
    const { data, upstreamStatus } = attempt.value;
    const durationMs = Date.now() - started;
    const fetchedAt = new Date();

    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "ok",
      durationMs,
      upstreamStatus,
      upstreamRequests: outboundRequests,
      subject: actor.subject,
      at: fetchedAt,
    });

    // Cache the real instant; TTL is measured against it.
    writeCache(connector.slug, key, { fetchedAt, payload: data });

    return {
      fetchedAt: outwardInstant(fetchedAt),
      state: "fresh",
      data,
      connectorSlug: connector.slug,
      attribution,
      lastError: null,
      reason: null,
      quotaResetsAt: null,
      quotaScope: null,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const aborted = controller.signal.aborted;

    // 429/420 is `rateLimited`, not `upstreamError`; the real status is still recorded.
    const refused =
      !aborted && error instanceof UpstreamStatusError && isRateLimitStatus(error.status);

    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: aborted ? "timeout" : refused ? "rateLimited" : "upstreamError",
      durationMs,
      // Null on a timeout.
      upstreamStatus: !aborted && error instanceof UpstreamStatusError ? error.status : null,
      upstreamRequests: outboundRequests,
      subject: actor.subject,
      at: new Date(),
    });

    // Never log upstream error text: some APIs echo the request back.
    logger.warn(
      { scope: "connector.run", slug: connector.slug, aborted, durationMs },
      "Connector call failed",
    );

    // Rate limited: open a cooldown (honouring Retry-After) and tell the client to stop polling.
    if (refused && error instanceof UpstreamStatusError) {
      const seconds = error.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      const until = openCooldown(connector.slug, seconds);
      logger.warn(
        {
          scope: "connector.run",
          slug: connector.slug,
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
          cooldownUntil: until.toISOString(),
        },
        "Upstream rate-limited us; backing off",
      );

      const message = `This source asked us to slow down. Waiting ${seconds}s before trying again.`;
      return staleUsable
        ? {
            fetchedAt: staleUsable.fetchedAt,
            state: "stale",
            data: staleUsable.payload as Result,
            connectorSlug: connector.slug,
            attribution,
            lastError: message,
            reason: "rate-limited",
            quotaResetsAt: null,
            quotaScope: null,
          }
        : unavailable(
            connector.slug,
            "rate-limited",
            message,
            attribution,
            cached?.fetchedAt ?? null,
          );
    }

    return degradeToStale(
      aborted
        ? "This source did not respond in time."
        : "This source could not be reached just now.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown by a driver when the upstream answered with a non-2xx, so the status is auditable. */
export class UpstreamStatusError extends Error {
  readonly status: number;
  /** Seconds from `Retry-After`, when the upstream sent one. Null when it did not. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null = null) {
    super(`Upstream responded ${status}`);
    this.name = "UpstreamStatusError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Statuses meaning "stop calling us": 429, and the non-standard 420 that adsb.lol returns. */
export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 420;
}

/** Parse `Retry-After`: delta-seconds, or an HTTP-date. Returns null for anything else. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  // `Number("")` is 0, which would mean "retry immediately".
  if (trimmed === "") return null;

  // Don't fall through to Date.parse for negatives: V8 parses "-5" as year -5.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : null;

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - now.getTime()) / 1000));
}

/** Test seam: drop every cached payload. Not exported from the package index. */
export function clearConnectorCache(): void {
  payloadCache.clear();
  // Clear the refusal memo too, so tests exercise `isLive` rather than a remembered answer.
  refusalMemo.clear();
}
