import type { Connector } from "@/db/schema";
import { logger } from "@/lib/logger";
import { getLiveConnector } from "@/lib/queries/live";
import { consume } from "@/lib/rate-limit";
import { recordConnectorRequest } from "./audit";
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

if (typeof window !== "undefined") {
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

  const connector = options.connector ?? (await getLiveConnector(driver.kind));

  if (!connector) {
    // No published, enabled connector with a recorded legal basis. This is a decision
    // somebody made, not a fault, and the copy must say so.
    logger.info({ scope: "connector.run", kind: driver.kind }, "No live connector for surface");
    return unavailable(
      driver.slug,
      "disabled",
      "This live source is switched off. No request was made.",
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
    // A malformed request is ours to reject, not the upstream's. Nothing is called and
    // nothing is audited: no outbound attempt took place.
    logger.warn({ scope: "connector.run", slug: connector.slug, err: error }, "Bad parameters");
    return unavailable(connector.slug, "upstream-down", "That request could not be understood.", attribution);
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

    await recordConnectorRequest({
      connectorId: connector.id,
      outcome: aborted ? "timeout" : "upstreamError",
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
  constructor(status: number) {
    super(`Upstream responded ${status}`);
    this.name = "UpstreamStatusError";
    this.status = status;
  }
}

/** Test seam: drop every cached payload. Not exported from the package index. */
export function clearConnectorCache(): void {
  payloadCache.clear();
}
