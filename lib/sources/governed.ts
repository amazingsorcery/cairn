import type { Connector } from "@/db/schema";
import { recordConnectorRequest, type AuditEntry } from "@/lib/connectors/audit";
import { isLive, notLiveReason } from "@/lib/connectors/liveness";
import { logger } from "@/lib/logger";
import { tallyOutbound } from "@/lib/net/outbound-tally";
import { getConnectorBySlug } from "@/lib/queries/live";
import { consume } from "@/lib/rate-limit";

import { lastUpstreamStatus } from "./http";
import type {
  Attribution,
  SourceAdapter,
  SourceContext,
  SourceFailure,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * The governed entry point for sources. Nothing else may call `adapter.fetch` directly, so
 * the kill switch, global ceiling and audit log apply to map polls as well as connectors.
 *
 * No per-user quota: a poller has no user. The kill switch, global ceiling and audit row
 * (with `worker` as the actor) all still apply.
 */

/** The subject recorded for a poll. Not a person; hashed like every other actor. */
export const WORKER_ACTOR_SUBJECT = "worker";

/**
 * A governed poll: the result plus the TTL and attribution, where the registry row wins over
 * the adapter (operators can change it without a deploy). Adapter values are the fallback.
 */
export interface GovernedPoll<T extends SourceFeature> {
  readonly result: SourceResult<T>;
  /** Cache lifetime the caller must honour. The registry row wins over the adapter. */
  readonly ttlSeconds: number;
  /** Required credit. Text from the row if set; licence and href from the adapter. */
  readonly attribution: Attribution;
  /** The registry row this poll was authorised against. */
  readonly connectorSlug: string;
}

/** Test seams; defaults are the real implementations. */
export interface GovernanceDeps {
  getConnector(slug: string): Promise<Connector | null>;
  consumeGlobal(
    slug: string,
    policy: { limit: number; windowSeconds: number },
    now: Date,
  ): Promise<{ ok: boolean }>;
  audit(entry: AuditEntry): Promise<void>;
  now(): Date;
}

const realDeps: GovernanceDeps = {
  getConnector: (slug) => getConnectorBySlug(slug),
  consumeGlobal: (slug, policy, now) =>
    consume("connector-global", slug, { policy, now }).then((r) => ({ ok: r.ok })),
  audit: (entry) => recordConnectorRequest(entry),
  now: () => new Date(),
};

/* `isLive` / `notLiveReason` are shared with `runConnector`; don't duplicate them here. */

/* ------------------------------------------------------------------ *
 * Remembered refusal
 * ------------------------------------------------------------------ */

/**
 * A refusal already computed and audited, held for a bounded window, so `/map` page views
 * don't each cost a registry read and an audit row per disabled layer.
 *
 * Only refusals are cached: live rows are read every poll, so switching a source off is
 * immediate; switching it on waits out the window. Audited once per window.
 */
interface RememberedRefusal {
  readonly until: number;
  readonly reason: string;
  readonly ttlSeconds: number;
  /** As resolved at the time, so a remembered refusal matches the first one exactly. */
  readonly attribution: Attribution;
}

const globalForMemo = globalThis as typeof globalThis & {
  __cairnSourceRefusalMemo__?: Map<string, RememberedRefusal>;
};
const refusalMemo: Map<string, RememberedRefusal> = (globalForMemo.__cairnSourceRefusalMemo__ ??=
  new Map());

/** Refusals are remembered for the row's cache TTL, capped at this (or this, with no row). */
const MAX_REFUSAL_MEMO_SECONDS = 60;

function rememberRefusal(
  slug: string,
  reason: string,
  ttlSeconds: number,
  attribution: Attribution,
  now: Date,
): void {
  const seconds = Math.max(1, Math.min(ttlSeconds, MAX_REFUSAL_MEMO_SECONDS));
  refusalMemo.set(slug, {
    until: now.getTime() + seconds * 1000,
    reason,
    ttlSeconds,
    attribution,
  });
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
 * Forget every remembered refusal. Called by the admin kill switch (immediate in this process
 * only; other processes wait out their window) and by tests.
 */
export function resetGovernanceMemo(): void {
  refusalMemo.clear();
}

/**
 * Map a poll outcome to an audit outcome and status. `schemaChanged` is `upstreamError` with
 * the real status (often 200).
 */
function auditOutcome<T extends SourceFeature>(
  result: SourceResult<T>,
  slug: string,
): { outcome: AuditEntry["outcome"]; upstreamStatus: number | null; called: boolean } {
  const status = lastUpstreamStatus(slug);
  if (result.ok) return { outcome: "ok", upstreamStatus: status, called: true };

  const failure: SourceFailure = result.failure;
  switch (failure.kind) {
    case "rateLimited":
      return { outcome: "rateLimited", upstreamStatus: status, called: true };
    case "quotaExhausted":
      // Our own ceiling refused before any request.
      return { outcome: "quotaDenied", upstreamStatus: null, called: false };
    case "timeout":
      return { outcome: "timeout", upstreamStatus: null, called: true };
    case "upstreamError":
      return { outcome: "upstreamError", upstreamStatus: failure.status ?? status, called: true };
    case "redirected":
      // The outcome enum has no redirect value; record `upstreamError` with the real 3xx.
      return { outcome: "upstreamError", upstreamStatus: status, called: true };
    case "schemaChanged":
      return { outcome: "upstreamError", upstreamStatus: status, called: true };
    case "notConfigured":
    case "disabled":
      // No request: no key, or the adapter declined.
      return { outcome: "disabled", upstreamStatus: null, called: false };
  }
}

/**
 * The credit to render: the row's text if set (so wording can change without a deploy),
 * otherwise the adapter's. `licence` and `href` always come from the adapter (no columns).
 */
function resolveAttribution<T extends SourceFeature>(
  adapter: SourceAdapter<T>,
  connector: Connector | null,
): Attribution {
  const rowText = connector?.attribution?.trim();
  /* Blank means unset, not "no credit owed". */
  if (!rowText) return adapter.attribution;
  if (rowText === adapter.attribution.text) return adapter.attribution;
  return { ...adapter.attribution, text: rowText };
}

/** A refusal that made no request. */
function refused<T extends SourceFeature>(
  adapter: SourceAdapter<T>,
  reason: string,
  connector: Connector | null = null,
): GovernedPoll<T> {
  return {
    result: { ok: false, failure: { kind: "disabled", reason }, lastGoodAt: null },
    ttlSeconds: connector?.cacheTtlSeconds ?? adapter.ttlSeconds,
    attribution: resolveAttribution(adapter, connector),
    connectorSlug: adapter.slug,
  };
}

/**
 * Poll one source, governed. The entry point every caller uses.
 *
 *   1. Registry and kill switch: if off, return `disabled` with no request.
 *   2. Global ceiling: fails closed on a DB error.
 *   3. The call, then the audit row.
 *
 * Refusals are audited too.
 */
export async function pollSource<T extends SourceFeature>(
  adapter: SourceAdapter<T>,
  query: SourceQuery,
  ctx: SourceContext,
  deps: Partial<GovernanceDeps> = {},
): Promise<GovernedPoll<T>> {
  const d: GovernanceDeps = { ...realDeps, ...deps };
  const now = d.now();

  /* 1. Registry and kill-switch -------------------------------------- */

  // Remembered refusal: no registry read, no audit row, same result as the first time.
  const remembered = recallRefusal(adapter.slug, now);
  if (remembered) {
    return {
      result: { ok: false, failure: { kind: "disabled", reason: remembered.reason }, lastGoodAt: null },
      ttlSeconds: remembered.ttlSeconds,
      attribution: remembered.attribution,
      connectorSlug: adapter.slug,
    };
  }

  let connector: Connector | null = null;
  try {
    connector = await d.getConnector(adapter.slug);
  } catch (error) {
    // Can't prove we're allowed to call; fail closed.
    logger.error(
      { scope: "source.poll", slug: adapter.slug, err: error },
      "Registry lookup failed; refusing to call upstream",
    );
    // Not remembered: a DB fault isn't a decision about the source.
    return refused(adapter, "the source registry is unavailable, so no call was authorised");
  }

  if (!connector || !isLive(connector)) {
    const reason = notLiveReason(connector, adapter.slug);
    rememberRefusal(
      adapter.slug,
      reason,
      connector?.cacheTtlSeconds ?? adapter.ttlSeconds,
      resolveAttribution(adapter, connector),
      now,
    );
    // Return before any request; the refusal is still audited.
    if (connector) {
      await d.audit({
        connectorId: connector.id,
        outcome: "disabled",
        durationMs: 0,
        upstreamStatus: null,
        upstreamRequests: 0,
        subject: WORKER_ACTOR_SUBJECT,
        at: now,
      });
    }
    logger.info(
      { scope: "source.poll", slug: adapter.slug, reason },
      "Source not live; no call made",
    );
    return refused(adapter, reason, connector);
  }

  /* 2. Global ceiling ------------------------------------------------- */

  try {
    const global = await d.consumeGlobal(
      connector.slug,
      { limit: connector.globalCeiling, windowSeconds: connector.windowSeconds },
      now,
    );
    if (!global.ok) {
      await d.audit({
        connectorId: connector.id,
        outcome: "quotaDenied",
        durationMs: 0,
        upstreamStatus: null,
        upstreamRequests: 0,
        subject: WORKER_ACTOR_SUBJECT,
        at: now,
      });
      logger.warn(
        { scope: "source.poll", slug: connector.slug },
        "Global ceiling reached; no call made",
      );
      // `rateLimited` is the closest typed failure; the audit row says `quotaDenied` (ours).
      return {
        result: {
          ok: false,
          failure: { kind: "rateLimited", retryAfterSeconds: connector.windowSeconds },
          lastGoodAt: null,
        },
        ttlSeconds: connector.cacheTtlSeconds,
        attribution: resolveAttribution(adapter, connector),
        connectorSlug: connector.slug,
      };
    }
  } catch (error) {
    logger.error(
      { scope: "source.poll", slug: connector.slug, err: error },
      "Ceiling check failed; refusing to call upstream",
    );
    await d.audit({
      connectorId: connector.id,
      outcome: "quotaDenied",
      durationMs: 0,
      upstreamStatus: null,
      upstreamRequests: 0,
      subject: WORKER_ACTOR_SUBJECT,
      at: now,
    });
    return refused(adapter, "rate limiting is unavailable, so no call was authorised", connector);
  }

  /* 3. The call, then the audit row ----------------------------------- */

  // Count outbound requests at `fetch` (one poll can make many, e.g. NWS zone lookups).
  const started = Date.now();
  const attempt = await tallyOutbound(() => adapter.fetch(query, ctx));
  const durationMs = Date.now() - started;

  // Rethrow adapter errors, but audit the requests made before the throw.
  if (!attempt.ok) {
    await d.audit({
      connectorId: connector.id,
      outcome: "upstreamError",
      durationMs,
      upstreamStatus: lastUpstreamStatus(adapter.slug),
      upstreamRequests: attempt.outboundRequests,
      subject: WORKER_ACTOR_SUBJECT,
      at: new Date(),
    });
    throw attempt.error;
  }

  const result = attempt.value;

  const { outcome, upstreamStatus, called } = auditOutcome(result, adapter.slug);
  await d.audit({
    connectorId: connector.id,
    outcome,
    durationMs: called ? durationMs : 0,
    upstreamStatus,
    upstreamRequests: called ? attempt.outboundRequests : 0,
    subject: WORKER_ACTOR_SUBJECT,
    at: new Date(),
  });

  return {
    result,
    // The row wins for TTL and credit wording.
    ttlSeconds: connector.cacheTtlSeconds,
    attribution: resolveAttribution(adapter, connector),
    connectorSlug: connector.slug,
  };
}

/** Healthcheck through the same governance, so it never probes a disabled upstream. */
export async function healthcheckSource<T extends SourceFeature>(
  adapter: SourceAdapter<T>,
  ctx: SourceContext,
  deps: Partial<GovernanceDeps> = {},
): Promise<{ ok: boolean; detail: string }> {
  const poll = await pollSource(adapter, {}, ctx, deps);
  if (poll.result.ok) {
    return {
      ok: true,
      detail: `${poll.result.features.length} features, observed ${poll.result.observedAt.toISOString()}`,
    };
  }
  const failure = poll.result.failure;
  return { ok: false, detail: failure.kind === "disabled" ? failure.reason : failure.kind };
}
