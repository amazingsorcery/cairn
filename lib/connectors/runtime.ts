import type { Connector } from "@/db/schema";
import { logger } from "@/lib/logger";
import { getConnectorBySlug } from "@/lib/queries/live";
import { isLive, notLiveReason } from "./liveness";
import { consume } from "@/lib/rate-limit";
import { recordConnectorRequest } from "./audit";
import { e2eOverride } from "./e2e-override";
import type { ActorIdentity, ConnectorDriver, ConnectorEnvelope } from "./types";

/**
 * The one path an outbound call takes. ADR 0011 rules 3–6, ADR 0014.
 *
 * SERVER-SIDE ONLY, enforced below. The `server-only` package — which would make importing
 * this from a Client Component a *build* error — is not in `package.json`; ask for it and
 * this guard becomes belt and braces rather than the only strap. Until then the module
 * refuses to load in a browser bundle, which turns the mistake into an immediate, obvious
 * failure instead of a silent leak of the user's IP and viewport to a third party
 * (ADR 0011 §1).
 *
 * ORDER OF CHECKS, and why it is this order:
 *
 *   1. registry lookup     — is there a published, enabled connector with a recorded legal
 *                            basis for this surface? (kill-switch, ADR 0012 §1)
 *   2. global ceiling      — would this call breach the upstream's fair use across ALL our
 *                            users? Checked before the per-user quota because it protects a
 *                            third party rather than us, and a user under their own quota
 *                            must still be refused when the ceiling is reached.
 *   3. per-user quota      — ADR 0011 rule 3.
 *   4. the call itself     — with an AbortSignal armed to the connector's `timeout_ms`.
 *
 * Every one of those, including the two refusals, is written to the audit log.
 *
 * NOTHING HERE THROWS for an expected failure. It returns a degraded envelope, because
 * ADR 0011 rule 5 requires the surface to state what is wrong and how old the data is, and
 * an exception loses both.
 */

/**
 * "Is this a real browser?" — `window` alone is not the test, because jsdom (Vitest's default
 * environment) defines it while still running under Node. `process.versions.node` is present
 * in every server runtime and in jsdom, and absent in a browser bundle, so the pair
 * distinguishes the case that matters.
 */
const IN_BROWSER =
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof process === "undefined";

if (IN_BROWSER) {
  throw new Error(
    "lib/connectors is server-only. Importing it into a Client Component would send the " +
      "user's IP and viewport straight to the upstream, which ADR 0011 §1 forbids. Call it " +
      "from a Route Handler or a Server Component instead.",
  );
}

/** The one shared in-process cache. ADR 0014 §4 and §6. */
type CacheEntry = { fetchedAt: Date; payload: unknown };

/**
 * ADR 0014 §6: cached payloads exist ONLY in a cache, never in a table. There is no
 * `flight_positions` table and there never will be — the prohibition is written into
 * `db/schema.ts` above the Live subtree. This Map is that cache: bounded, ephemeral, keyed
 * by connector plus normalised parameters and NEVER by user (§4), with a maximum lifetime of
 * `ttl + swr`.
 *
 * A `Map` on the server process rather than `unstable_cache`, for one reason: `fetchedAt`
 * must be the real upstream response time, and a second cache layer with its own clock is
 * exactly the two-clocks-disagreeing failure ADR 0014 §5 rejects. It is lost on restart,
 * which costs one cold fetch — §6 says explicitly that a table to avoid that is not a
 * trade we will make.
 */
const globalForCache = globalThis as typeof globalThis & {
  __cairnConnectorCache__?: Map<string, CacheEntry>;
};
const payloadCache: Map<string, CacheEntry> = (globalForCache.__cairnConnectorCache__ ??=
  new Map());

/**
 * Hard ceiling on distinct cache entries, so a crafted stream of viewport parameters cannot
 * grow this Map without bound on a 2 GB box. Eviction is oldest-first; the driver's
 * `normalise` is the first line of defence, quantising parameters so the key space is small.
 */
const MAX_CACHE_ENTRIES = 256;

function readCache(key: string): CacheEntry | undefined {
  return payloadCache.get(key);
}

function writeCache(key: string, entry: CacheEntry): void {
  if (payloadCache.size >= MAX_CACHE_ENTRIES && !payloadCache.has(key)) {
    const oldest = payloadCache.keys().next();
    if (!oldest.done) payloadCache.delete(oldest.value);
  }
  payloadCache.set(key, entry);
}

/* ------------------------------------------------------------------ *
 * Upstream backoff — the QA finding Q-02
 * ------------------------------------------------------------------ */

/**
 * Per-connector cooldown: the instant after which we may call this upstream again.
 *
 * WHY THIS EXISTS. The audit log recorded 57 `429`s and one `420` against adsb.lol — 29% of
 * every outbound call refused — because nothing here backed off. The envelope degraded to
 * `stale`, the client kept polling, and we kept calling a free community service that had
 * told us to stop. product-brief §3.2 constraint 5 — "respect robots.txt, terms of service
 * and rate limits" — is the line between OSINT and a computer-misuse offence, and it is the
 * thing this product tells its own users to care about.
 *
 * Our quota columns are a CEILING, not the authority. **The upstream's own limiter is the
 * authority**, and a 429 is it speaking. When it speaks we stop, for `Retry-After` if it sent
 * one and for `DEFAULT_COOLDOWN_SECONDS` if it did not.
 *
 * In-process, like the payload cache: bounded, ephemeral, no user attached, lost on restart.
 * A restart costs one probe request, which is the correct trade — persisting it would mean a
 * table of upstream state, and the Live subtree deliberately has none.
 */
const globalForCooldown = globalThis as typeof globalThis & {
  __cairnConnectorCooldown__?: Map<string, Date>;
};
const cooldownUntil: Map<string, Date> = (globalForCooldown.__cairnConnectorCooldown__ ??=
  new Map());

/**
 * Used when a 429 carries no `Retry-After` — which is the case for adsb.lol, measured
 * 2026-08-31: neither a 200 nor a 429 from it carries one.
 *
 * 60 seconds is deliberately longer than the connector's window. The upstream's limiter is a
 * load-dependent token bucket with no published number, so the only safe assumption is that
 * it needs materially longer than our own window to refill. Backing off for less than a
 * window would just re-enter the burst that caused the refusal.
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

function unavailable<T>(
  slug: string,
  reason: NonNullable<ConnectorEnvelope<T>["reason"]>,
  message: string,
  attribution: string | null = null,
  fetchedAt: Date | null = null,
): ConnectorEnvelope<T> {
  return {
    fetchedAt,
    state: "unavailable",
    data: null,
    connectorSlug: slug,
    attribution,
    lastError: message,
    reason,
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

  /* 1. Registry, kill-switch and legal basis ------------------------- */

  /*
   * Resolve by SLUG, never by kind.
   *
   * This previously read `getLiveConnector(driver.kind)`, which returns the first enabled row
   * of that kind. Once more than one connector shared a kind that became a real defect, and
   * both tools-engineers hit it independently on the same day: the Overpass driver was handed
   * the Cloudflare DNS row and POSTed an Overpass query at that base URL.
   *
   * A request went out to an operator we had not decided to call, under someone else's
   * recorded legal basis, spending someone else's quota, and the reader saw the wrong
   * attribution. It surfaced as an ordinary "source unreachable", which is why it survived —
   * the failure looks exactly like the upstream having a bad day.
   *
   * A driver knows which connector it is. A kind is a category, and a category was never an
   * identity.
   */
  const connector = options.connector ?? (await getConnectorBySlug(driver.slug));

  /*
   * TEST-ONLY STATE OVERRIDE - see `./e2e-override.ts`.
   *
   * ABOVE the "no live connector" return on purpose. The registry read is a database query,
   * not an outbound call, so doing it first costs nothing and lets a forced state carry the
   * operator's real attribution when there is a row. But the override must still fire when
   * there is NO live row - which is the normal state of `adsb-lol`, seeded draft and
   * disabled so it fails closed - because otherwise the hook is unusable in exactly the
   * situation it was written for.
   *
   * A forced state stands in for the WHOLE call: no cache read, no quota consumed, no audit
   * row, and above all no outbound request. It is disabled unconditionally when
   * NODE_ENV === "production", which `e2eOverride` checks before it reads any variable.
   *
   * It exists because /live/flights calls a third party from OUR server, so a browser test
   * cannot intercept it. Without it the four degraded states of ADR 0011 rule 5 were only
   * observable by luck, and architecture HANDOFF section 11 assertion 21 - "the stale and
   * unavailable states are reachable in tests, not just theoretically implemented" - could
   * not be met at all.
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
   * THE KILL-SWITCH. Checked here, before anything else, because everything below this line
   * makes a real outbound request.
   *
   * `getConnectorBySlug` returns a row regardless of state — that is deliberate, so an
   * operator surface can read a disabled row. The predicate it replaced (`getLiveConnector`)
   * applied these four conditions inside its SQL, and when it was swapped out the filter was
   * not carried across. For a period every connector sat `enabled = false, status = 'draft'`
   * and called its upstream anyway, on anonymous requests, including two whose own recorded
   * legal basis says an operator must decide deliberately first.
   *
   * `isLive` now lives in one file and is imported by both governed paths. Do not re-express
   * it here, and do not assume a row returned from a query is a row you may call.
   */
  if (connector === null || !isLive(connector)) {
    const reason = notLiveReason(connector, driver.slug);
    logger.info(
      { scope: "connector.run", slug: driver.slug, reason },
      "Refused before calling upstream: connector is not live",
    );
    // Audit the refusal. An operator asking "did we stop calling them?" needs the answer to
    // be a row, not the absence of one — an absence is indistinguishable from nobody asking.
    if (connector !== null) {
      await recordConnectorRequest({
        connectorId: connector.id,
        outcome: "disabled",
        durationMs: 0,
        upstreamStatus: null,
        subject: actor.subject,
        at: now,
      });
    }
    return unavailable(
      driver.slug,
      "disabled",
      `This live source is switched off — ${reason}. No request was made.`,
    );
  }

  /**
   * Attribution travels in the envelope so the UI renders it next to the data rather than in
   * a footer (ADR 0011 rule 2). It is non-null whenever it is owed:
   * `connectors_attribution_check` makes `attribution_required = true` with a null string
   * impossible to store.
   */
  const attribution = connector.attribution;

  let params: Params;
  try {
    params = driver.normalise(rawParams);
  } catch (error) {
    /*
     * A malformed request is OURS to reject, not the upstream's. Nothing is called and
     * nothing is audited, because no outbound attempt took place.
     *
     * The reason is `bad-request`, not `upstream-down`. It used to be the latter, which meant
     * every surface branching on `reason` told the reader a third party was failing when in
     * fact we had rejected what they typed — and on the Toolbench, where the parameters come
     * from a text field, that is the difference between "fix your input" and "try again
     * later". The error is logged but never returned: it is a Zod message describing the
     * caller's own value, and on these surfaces that value is the reader's query.
     */
    logger.warn({ scope: "connector.run", slug: connector.slug, err: error }, "Bad parameters");
    return unavailable(
      connector.slug,
      "bad-request",
      "That request could not be understood, so nothing was requested from the source.",
      attribution,
    );
  }

  const key = `${connector.slug}:${driver.cacheKey(params)}`;
  const cached = readCache(key);

  /* 2. Serve from cache while fresh ---------------------------------- */

  if (cached && ageSeconds(cached.fetchedAt, now) <= connector.cacheTtlSeconds) {
    return {
      fetchedAt: cached.fetchedAt,
      state: "fresh",
      data: cached.payload as Result,
      connectorSlug: connector.slug,
      attribution,
      lastError: null,
      reason: null,
    };
  }

  /**
   * A payload past its TTL but inside the stale-while-revalidate horizon is what we fall
   * back to if the refresh below fails. Past `ttl + swr` we show nothing rather than
   * something old (ADR 0014 §3): there is a point past which "aircraft positions from 40
   * minutes ago" is not degraded service but a different and misleading product.
   */
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
        cached?.fetchedAt ?? null,
      );
    }
    return {
      fetchedAt: staleUsable.fetchedAt,
      state: "stale",
      data: staleUsable.payload as Result,
      connectorSlug: connector.slug,
      attribution,
      lastError: message,
      reason: "stale",
    };
  };

  /* 2b. Upstream backoff — do not call a service that told us to stop ---- */

  /**
   * Checked BEFORE our own quotas, because this is not our refusal to make. If the upstream
   * has asked us to back off, no accounting of ours can authorise the call.
   *
   * A cached payload inside the stale horizon still serves — degrading to `stale` is honest
   * and costs the upstream nothing. Only when there is nothing to serve does the surface go
   * `unavailable`, and it says WHY, so the client stops polling instead of hammering.
   */
  const cooling = cooldownRemaining(connector.slug, now);
  if (cooling > 0) {
    /**
     * `rateLimited`, NOT `quotaDenied` — the distinction is the whole point of the outcome
     * (migration 0005). `quotaDenied` means we refused the caller against a ceiling we chose;
     * this is us standing down because THEY refused us. An operator who reads `quotaDenied`
     * here goes and tunes our quota, which would do nothing.
     *
     * `duration_ms = 0` and a null `upstream_status`: nothing left the building this time.
     * The 429 that opened the cooldown is a separate row, also `rateLimited`, carrying the
     * real status — so the board shows both the refusal and the standing-down it caused.
     */
    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "rateLimited",
      durationMs: 0,
      upstreamStatus: null,
      subject: actor.subject,
      at: now,
    });

    const message = `This source asked us to slow down. Waiting ${cooling}s before trying again.`;
    return staleUsable
      ? {
          fetchedAt: staleUsable.fetchedAt,
          state: "stale",
          data: staleUsable.payload as Result,
          connectorSlug: connector.slug,
          attribution,
          lastError: message,
          reason: "rate-limited",
        }
      : unavailable(
          connector.slug,
          "rate-limited",
          message,
          attribution,
          cached?.fetchedAt ?? null,
        );
  }

  /* 3. Quotas -------------------------------------------------------- */

  /**
   * The global ceiling first. It protects the UPSTREAM's fair-use limit from all of our
   * users combined (ADR 0011 rule 3), so it must bite even for a user well within their own
   * quota. Both counters use the ADR 0009 limiter, whose subject is hashed — the ceiling's
   * subject is the connector slug, which is not a person.
   *
   * These call `consume`, not `consumeSafely`. `consumeSafely` fails OPEN on a database
   * error, which is right for our own surfaces and wrong here: an uncounted call against
   * somebody else's fair-use limit is a call we had no right to make.
   */
  const policy = { limit: connector.globalCeiling, windowSeconds: connector.windowSeconds };
  const userPolicy = { limit: connector.perUserQuota, windowSeconds: connector.windowSeconds };

  try {
    const global = await consume("connector-global", connector.slug, { policy, now });
    if (!global.ok) {
      await recordConnectorRequest({
        connectorId: connector.id,
        outcome: "quotaDenied",
        durationMs: 0,
        upstreamStatus: null,
        subject: actor.subject,
        at: now,
      });
      return staleUsable
        ? degradeToStale("This source is at its shared rate limit; showing the last data we have.")
        : unavailable(
            connector.slug,
            "quota-exhausted",
            "This source is at its shared rate limit. Try again shortly.",
            attribution,
          );
    }

    const perUser = await consume("connector-user", `${connector.slug}:${actor.subject}`, {
      policy: userPolicy,
      now,
    });
    if (!perUser.ok) {
      await recordConnectorRequest({
        connectorId: connector.id,
        outcome: "quotaDenied",
        durationMs: 0,
        upstreamStatus: null,
        subject: actor.subject,
        at: now,
      });
      return staleUsable
        ? degradeToStale("You have reached this source's request limit; showing the last data we have.")
        : unavailable(
            connector.slug,
            "quota-exhausted",
            "You have reached this source's request limit. Try again shortly.",
            attribution,
          );
    }
  } catch (error) {
    // Fail CLOSED: we could not prove we are inside the ceiling, so we do not call.
    logger.error({ scope: "connector.run", slug: connector.slug, err: error }, "Quota check failed");
    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "quotaDenied",
      durationMs: 0,
      upstreamStatus: null,
      subject: actor.subject,
      at: now,
    });
    return staleUsable
      ? degradeToStale("Rate limiting is unavailable; showing the last data we have.")
      : unavailable(
          connector.slug,
          "quota-exhausted",
          "This live source is temporarily unavailable.",
          attribution,
        );
  }

  /* 4. The call ------------------------------------------------------ */

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connector.timeoutMs);
  const started = Date.now();

  try {
    const { data, upstreamStatus } = await driver.fetch(connector, params, controller.signal);
    const durationMs = Date.now() - started;
    const fetchedAt = new Date();

    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: "ok",
      durationMs,
      upstreamStatus,
      subject: actor.subject,
      at: fetchedAt,
    });

    writeCache(key, { fetchedAt, payload: data });

    return {
      fetchedAt,
      state: "fresh",
      data,
      connectorSlug: connector.slug,
      attribution,
      lastError: null,
      reason: null,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const aborted = controller.signal.aborted;

    /**
     * A 429 or 420 is `rateLimited`, not `upstreamError`. `upstreamError` should mean the
     * source is broken; being told to slow down is the source working exactly as designed and
     * us being at fault. Keeping the real `upstream_status` on the row means the board can
     * still show which code it was.
     */
    const refused =
      !aborted && error instanceof UpstreamStatusError && isRateLimitStatus(error.status);

    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: aborted ? "timeout" : refused ? "rateLimited" : "upstreamError",
      durationMs,
      // Null on a timeout: no status was received. On an upstream error the driver throws
      // an UpstreamStatusError carrying one.
      upstreamStatus: !aborted && error instanceof UpstreamStatusError ? error.status : null,
      subject: actor.subject,
      at: new Date(),
    });

    // The upstream's own error text is never surfaced or logged verbatim: it is third-party
    // content of unknown shape, and on some APIs it echoes the request back.
    logger.warn(
      { scope: "connector.run", slug: connector.slug, aborted, durationMs },
      "Connector call failed",
    );

    /**
     * THEY TOLD US TO STOP. Open a cooldown so nothing calls again until it expires, and
     * return a reason the client knows to stop polling on. Honouring `Retry-After` when it is
     * sent is the difference between backing off and guessing.
     */
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

/**
 * The two statuses that mean "stop calling us".
 *
 * 429 is the standard. **420 "Enhance Your Calm"** is non-standard but is what adsb.lol
 * actually returns under load, and our audit log has one. Treating it as a generic upstream
 * error would keep us calling into a service that has asked us twice, in two different ways,
 * to stop.
 */
export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 420;
}

/** Parse `Retry-After`: delta-seconds, or an HTTP-date. Returns null for anything else. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  // `Number("")` and `Number("   ")` are both 0, not NaN — so without this guard an empty
  // header would parse as "retry immediately" and open no cooldown at all. Caught by
  // `backoff.test.ts`; it is the exact shape of bug that makes a backoff silently absent.
  if (trimmed === "") return null;

  /**
   * A numeric value is a delta-seconds attempt, and we answer it here either way — we do NOT
   * fall through to the date branch on a negative one. `Date.parse("-5")` yields a valid
   * instant (year -5) in V8, so falling through would clamp a malformed header to 0 and open
   * no cooldown. Malformed means "we were told nothing usable", which is null, which is the
   * default cooldown.
   */
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : null;

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - now.getTime()) / 1000));
}

/** Test seam: drop every cached payload. Not exported from the package index. */
export function clearConnectorCache(): void {
  payloadCache.clear();
}
