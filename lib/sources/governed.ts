import type { Connector } from "@/db/schema";
import { recordConnectorRequest, type AuditEntry } from "@/lib/connectors/audit";
import { logger } from "@/lib/logger";
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
 * The governed entry point. **Nothing outside this module may call `adapter.fetch` directly.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — the defect it closes
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/sources/` grew its own HTTP path, and for a while that path was neither governed by
 * the kill-switch nor audited. Two consequences, and the first is the worse:
 *
 * 1. **`connectors.enabled` did not stop it.** adsb.lol is reachable by two routes — the
 *    connector seam (governed) and the source seam (not) — so an operator hitting the
 *    kill-switch at 3am silenced `/live/flights` while `/map` carried on calling.
 *    **A kill-switch that does not kill is worse than no kill-switch**, because the operator
 *    believes the traffic stopped and stops looking.
 *
 * 2. **No `connector_requests` row.** Product-brief §3.3 requires every outbound query to be
 *    audit-logged. That log is not bookkeeping: QA finding Q-02 was *found* by reading it —
 *    `ok/200 = 140` against `upstreamError/429 = 57` is what proved we were exceeding
 *    adsb.lol's rate while the recorded legal basis claimed otherwise. Six adapters calling
 *    out with no such evidence available is the same blindness, rebuilt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* CARRIED OVER FROM `runConnector`
 * ─────────────────────────────────────────────────────────────────────────────
 * **The per-user quota.** A poller answers a timer; there is no user, and inventing a
 * synthetic one to satisfy a shape would put a fiction into a table whose entire value is
 * that it is evidence. ADR 0024 reaches the same conclusion from the schema side: under
 * `poll_mode = 'worker'`, `perUserQuota` "governs nothing outbound at all".
 *
 * That argument is about the *caller*, and it says nothing about the other three controls:
 *
 *   - The **kill-switch** is about whether we may call this upstream at all. Who triggered
 *     the call is irrelevant to it, so it applies here unchanged.
 *   - The **global ceiling** protects the upstream's fair-use limit rather than our users, so
 *     it applies here too — under `worker` mode it is a ceiling on the poller alone.
 *   - The **audit row** is written with the worker as the actor, hashed by the same
 *     construction as every other row (ADR 0013). `worker` is a subject, not a person.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** The subject recorded for a poll. Not a person; hashed like every other actor (ADR 0013). */
export const WORKER_ACTOR_SUBJECT = "worker";

/**
 * A governed poll: the result, plus the two things the registry row is authoritative for.
 *
 * `ttlSeconds` is the **row's** `cache_ttl_seconds` whenever a row exists, not the adapter's
 * constant. ADR 0024 recorded the two disagreeing for adsb.lol — 60s on the row against 30s
 * in the adapter — and the row has to win: it is what an operator can change under load
 * without a deploy, which is the same argument that made `enabled` a column (ADR 0012 §3).
 * The adapter's value is the fallback for a source that has no row yet.
 */
export interface GovernedPoll<T extends SourceFeature> {
  readonly result: SourceResult<T>;
  /** Cache lifetime the caller must honour. The registry row wins over the adapter. */
  readonly ttlSeconds: number;
  /** Returned so a caller cannot render a layer without the credit its licence requires. */
  readonly attribution: Attribution;
  /** The registry row this poll was authorised against. */
  readonly connectorSlug: string;
}

/**
 * Seams for tests. Every default is the real implementation; a test supplies fakes so the
 * governance logic can be exercised without a database.
 */
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

/**
 * Is this row live? The same four conditions `getLiveConnector` applies, checked **by slug**
 * because one `kind` may now hold several sources (ADR 0024).
 *
 * `termsUrl` and `legalBasis` are part of the test, not decoration: a source published
 * without a recorded basis for calling it is exactly what ADR 0012's CHECK constraints exist
 * to prevent, and re-checking here means the governed path cannot be the place that slips.
 */
function isLive(connector: Connector): boolean {
  return (
    connector.enabled &&
    connector.status === "published" &&
    connector.termsUrl !== null &&
    connector.legalBasis !== null
  );
}

/** Why a row is not live, in one sentence fit to render. Never speculative. */
function disabledReason(connector: Connector | null, slug: string): string {
  if (!connector) return `${slug} has no registry row, so there is no recorded basis to call it`;
  if (!connector.enabled) return "an operator switched this source off";
  if (connector.status !== "published") return `this source is ${connector.status}, not published`;
  return "this source has no recorded terms or legal basis";
}

/**
 * Map a poll outcome to an audit outcome and an upstream status.
 *
 * `schemaChanged` records `upstreamError`: as far as the surface is concerned the source is
 * down, and the status stays whatever the wire actually said — a 200 carrying an unparseable
 * body is a true and useful pair of facts for an operator staring at the board.
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
      // `quotaDenied` on the board, and `called: false`: our own ceiling refused this before
      // anything left the building, so counting it as an upstream call would overstate our
      // rate against a limit the whole audit log exists to let us verify.
      return { outcome: "quotaDenied", upstreamStatus: null, called: false };
    case "timeout":
      // No status was received, by definition.
      return { outcome: "timeout", upstreamStatus: null, called: true };
    case "upstreamError":
      return { outcome: "upstreamError", upstreamStatus: failure.status ?? status, called: true };
    case "schemaChanged":
      return { outcome: "upstreamError", upstreamStatus: status, called: true };
    case "notConfigured":
    case "disabled":
      // Nothing left the building: no key, or the adapter declined before calling.
      return { outcome: "disabled", upstreamStatus: null, called: false };
  }
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
    attribution: adapter.attribution,
    connectorSlug: adapter.slug,
  };
}

/**
 * Poll one source, governed. **This is the entry point every caller uses.**
 *
 * Order of checks, and why it is this order:
 *
 *   1. **registry lookup and kill-switch** — may we call this upstream at all? A source that
 *      is off returns the typed `disabled` failure and **makes no request**.
 *   2. **global ceiling** — would this call breach the upstream's fair use? Checked before the
 *      call because it protects a third party. Fails CLOSED on a database error: we could not
 *      prove we were inside the ceiling, so we do not call.
 *   3. **the call itself**, then the audit row.
 *
 * Every one of those, including both refusals, is written to the audit log.
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

  let connector: Connector | null = null;
  try {
    connector = await d.getConnector(adapter.slug);
  } catch (error) {
    // We cannot prove we are allowed to call. Fail closed, exactly as for a quota failure.
    logger.error(
      { scope: "source.poll", slug: adapter.slug, err: error },
      "Registry lookup failed; refusing to call upstream",
    );
    return refused(adapter, "the source registry is unavailable, so no call was authorised");
  }

  if (!connector || !isLive(connector)) {
    const reason = disabledReason(connector, adapter.slug);
    /**
     * A kill-switch that does not kill is worse than none. **Return before any request.**
     * The refusal is still audited — ADR 0013 §4: a control denying traffic is the single
     * most useful thing this table can show an operator, and it is invisible if only
     * successful calls are recorded.
     */
    if (connector) {
      await d.audit({
        connectorId: connector.id,
        outcome: "disabled",
        durationMs: 0,
        upstreamStatus: null,
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
        subject: WORKER_ACTOR_SUBJECT,
        at: now,
      });
      logger.warn(
        { scope: "source.poll", slug: connector.slug },
        "Global ceiling reached; no call made",
      );
      /**
       * `rateLimited` is the closest typed failure, and the audit row carries the true
       * distinction (`quotaDenied` — our refusal, not theirs). Worth stating, because an
       * operator reading `rateLimited` goes and tunes our quota, which is the right move here
       * and the wrong one for a real upstream 429. See HANDOFF for the proposed
       * `quotaExhausted` member of `SourceFailure`.
       */
      return {
        result: {
          ok: false,
          failure: { kind: "rateLimited", retryAfterSeconds: connector.windowSeconds },
          lastGoodAt: null,
        },
        ttlSeconds: connector.cacheTtlSeconds,
        attribution: adapter.attribution,
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
      subject: WORKER_ACTOR_SUBJECT,
      at: now,
    });
    return refused(adapter, "rate limiting is unavailable, so no call was authorised", connector);
  }

  /* 3. The call, then the audit row ----------------------------------- */

  const started = Date.now();
  const result = await adapter.fetch(query, ctx);
  const durationMs = Date.now() - started;

  const { outcome, upstreamStatus, called } = auditOutcome(result, adapter.slug);
  await d.audit({
    connectorId: connector.id,
    outcome,
    // Zero when nothing left the building, matching the convention for every other refusal.
    durationMs: called ? durationMs : 0,
    upstreamStatus,
    subject: WORKER_ACTOR_SUBJECT,
    at: new Date(),
  });

  return {
    result,
    // The row wins. See `GovernedPoll.ttlSeconds`.
    ttlSeconds: connector.cacheTtlSeconds,
    attribution: adapter.attribution,
    connectorSlug: connector.slug,
  };
}

/**
 * Run a healthcheck through the same governance.
 *
 * An operator dashboard that probed upstreams while the kill-switch was on would be its own
 * small version of the bug this module fixes.
 */
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
