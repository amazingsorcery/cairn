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
  /**
   * Returned so a caller cannot render a layer without the credit its licence requires.
   *
   * The row's `attribution` column supplies the **text** when it is set; `licence` and `href`
   * are the adapter's, because no column carries them. See `resolveAttribution`.
   */
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

/*
 * `isLive` and `notLiveReason` are IMPORTED, not defined here.
 *
 * They used to be a second copy of the same four conditions, sitting beside a third copy in
 * `lib/queries/live.ts`'s SQL. When `runConnector` was refactored to resolve by slug, the
 * copy it relied on was deleted and nothing replaced it: every connector then called its
 * upstream while `enabled = false`, which is QA finding QV-01. One predicate, one file.
 */

/* ------------------------------------------------------------------ *
 * The remembered refusal — QA finding QV-05
 * ------------------------------------------------------------------ */

/**
 * A refusal we have already computed and already recorded, held for a bounded window.
 *
 * WHY. `/map` renders six layers per request, and with every connector in its shipped state
 * (`enabled = false, status = 'draft'`) each of those six did a `SELECT` against `connectors`
 * and an `INSERT` into `connector_requests`. Twenty anonymous page views wrote 120 rows into
 * the one table `lib/rate-limit.ts` describes as "the only [table] in the schema with no
 * natural bound". At a hundred requests a second that is tens of millions of rows a day on a
 * box where Postgres shares the hardware with the app — and the audit log's signal, which is
 * the artefact that found v1's Q-02, is buried under refusals nobody asked for.
 *
 * WHAT IS AND IS NOT CACHED, because this is the part that must not be got wrong. **Only a
 * refusal is remembered.** There is no positive cache here: a live row is looked up on every
 * poll, so an operator who switches a source OFF stops the traffic on the very next poll with
 * no TTL in between. That is the property `lib/queries/live.ts` deliberately paid for by
 * leaving the registry read uncached, and it is preserved exactly. What now waits out a
 * window is switching a source back ON, which is a scheduled decision made in daylight rather
 * than an incident response at 3am.
 *
 * The refusal is still audited — once per window rather than once per render. ADR 0013 §4
 * wants a control that denies traffic to be visible; one row per source per window shows an
 * operator that the source is off and stays off, without the surrounding noise.
 */
interface RememberedRefusal {
  readonly until: number;
  readonly reason: string;
  readonly ttlSeconds: number;
  /**
   * The credit as `resolveAttribution` computed it, carried so a remembered refusal is
   * byte-for-byte the refusal the first caller got. Recomputing it from the adapter constant
   * would print the module's credit on the second request and the operator's edited one on
   * the first, which is the divergence QV-17 is about, rebuilt one layer along.
   */
  readonly attribution: Attribution;
}

const globalForMemo = globalThis as typeof globalThis & {
  __cairnSourceRefusalMemo__?: Map<string, RememberedRefusal>;
};
const refusalMemo: Map<string, RememberedRefusal> = (globalForMemo.__cairnSourceRefusalMemo__ ??=
  new Map());

/**
 * How long a refusal is remembered: the registry row's own cache TTL, capped.
 *
 * The row's TTL is the number an operator already tunes for this source, and the cap keeps
 * the delay on re-enabling a source to something a human will wait through rather than
 * something they will assume is broken. A source with no row at all gets the cap.
 */
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
 * Forget every remembered refusal.
 *
 * Called by the admin kill-switch so re-enabling a source takes effect immediately in this
 * process, and by tests. It is in-process, like every other cache in this subtree, so a
 * second process still waits out its own window — which is the honest bound on the trade and
 * is written into ADR 0012's consequences rather than left for someone to discover.
 */
export function resetGovernanceMemo(): void {
  refusalMemo.clear();
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
    case "redirected":
      /*
       * `upstreamError` on the board, because `connector_requests.outcome` is a closed
       * database enum and a redirect is not worth a migration — but `called: true` and the
       * real 3xx as the status, so the row reads "they answered 302 and we did not follow"
       * rather than hiding behind a null. The distinct sentence is in the failure kind, which
       * is what the operator sees on the layer.
       */
      return { outcome: "upstreamError", upstreamStatus: status, called: true };
    case "schemaChanged":
      return { outcome: "upstreamError", upstreamStatus: status, called: true };
    case "notConfigured":
    case "disabled":
      // Nothing left the building: no key, or the adapter declined before calling.
      return { outcome: "disabled", upstreamStatus: null, called: false };
  }
}

/**
 * The credit to render: **the registry row's wording when it has one**, the adapter's
 * constant otherwise.
 *
 * ## Why this is not just the adapter constant (QA finding QV-17)
 *
 * `connectors.attribution` is documented as the string we are obliged to render, and
 * `connectors_attribution_check` makes it impossible to store a row that owes attribution
 * without one. It was nevertheless never read: every branch here returned
 * `adapter.attribution`, so an operator could edit the column and watch nothing change while
 * two files claimed the row was authoritative. The strings happen to agree for every source
 * today, so nothing was mis-credited — but attribution is precisely the field that has to be
 * changeable without a deploy, because a licence can change its required wording and an
 * operator can be asked for a different form of credit at short notice. The same argument
 * that made `cache_ttl_seconds` the row's (ADR 0024) applies here unchanged.
 *
 * **Only the text comes from the row.** There is no `licence` or `attribution_href` column,
 * so `licence` and `href` stay the adapter's — and this is a limit worth stating rather than
 * papering over: the row can change the credit we print, not the licence we claim to be
 * printing it under.
 */
function resolveAttribution<T extends SourceFeature>(
  adapter: SourceAdapter<T>,
  connector: Connector | null,
): Attribution {
  const rowText = connector?.attribution?.trim();
  /* A blank column is "nobody filled this in", not "no credit is owed": fall back. */
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

  /*
   * A refusal we have already computed and already recorded, inside its window. No registry
   * read, no audit row, no request — and the same refusal the first caller got, so a caller
   * cannot tell a remembered one from a fresh one. QV-05.
   */
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
    // We cannot prove we are allowed to call. Fail closed, exactly as for a quota failure.
    logger.error(
      { scope: "source.poll", slug: adapter.slug, err: error },
      "Registry lookup failed; refusing to call upstream",
    );
    // Deliberately NOT remembered: this is a database fault, not a decision about the
    // source, and holding it would keep a healthy source dark for a window after the
    // database came back.
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

  /**
   * The adapter runs inside an outbound tally (QV-09). One poll is not one request: the NWS
   * adapter makes an index call plus up to twelve zone lookups, and the audit row said one.
   * Counted at the `fetch` in `lib/sources/http.ts`, so an adapter cannot misdeclare it.
   */
  const started = Date.now();
  const attempt = await tallyOutbound(() => adapter.fetch(query, ctx));
  const durationMs = Date.now() - started;

  /*
   * An adapter is code this module does not own and `pollSource` has never caught for it;
   * rethrowing preserves that. The count is still taken, because requests made before the
   * throw were still made.
   */
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
    // Zero when nothing left the building, matching the convention for every other refusal.
    durationMs: called ? durationMs : 0,
    upstreamStatus,
    // `called` is the adapter's own report that it declined before calling (no API key, for
    // instance). The tally is what actually happened, and the two agree by construction.
    upstreamRequests: called ? attempt.outboundRequests : 0,
    subject: WORKER_ACTOR_SUBJECT,
    at: new Date(),
  });

  return {
    result,
    // The row wins, for the TTL and for the credit's wording. See `GovernedPoll.ttlSeconds`
    // and `resolveAttribution`.
    ttlSeconds: connector.cacheTtlSeconds,
    attribution: resolveAttribution(adapter, connector),
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
