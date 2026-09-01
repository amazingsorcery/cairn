import { connectorRequests, type ConnectorRequestOutcome } from "@/db/schema";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hashSubject } from "@/lib/rate-limit";

/**
 * The outbound audit log. ADR 0013.
 *
 * WHAT THIS RECORDS: that a call happened, what it cost, and how it ended.
 * WHAT IT DOES NOT RECORD, AND MUST NEVER BE MADE TO RECORD: what was asked for.
 *
 * There is no column for a path, a query string, a bounding box, a camera id or a response
 * body — and the prohibition is written into the block comment above the Live subtree in
 * `db/schema.ts` because "the natural instinct when debugging a failing connector is to add
 * exactly one of them temporarily". If you are here to add one, read ADR 0013 first: with a
 * bounding box plus a timestamp plus even a hashed actor, this table reconstructs research
 * patterns, and the hash stops being protective the moment the content beside it is
 * specific.
 *
 * The actor is `HMAC-SHA256(subject, RATE_LIMIT_SECRET)`, the identical construction as
 * `rate_limits.key` (one hashing approach in this codebase, not two), and
 * `connector_requests_actor_key_check` requires exactly 64 hex characters — so a raw uuid
 * (hyphens), an email (`@`) or an IP address (dots or colons) is *structurally impossible*
 * to store, from any code path including a hand-typed INSERT.
 */

/**
 * Retention. ADR 0013 §5: 30 days covers a fair-use dispute with an upstream and a
 * month-over-month error-rate comparison, and is far short of anything that could
 * reconstruct a user's research over a story's lifetime.
 */
export const AUDIT_RETENTION_DAYS = 30;

export type AuditEntry = {
  connectorId: string;
  outcome: ConnectorRequestOutcome;
  /** Wall-clock cost of the attempt. 0 for `quotaDenied`, `disabled` and a cooldown. */
  durationMs: number;
  /** Upstream HTTP status. Null when no request was made, or when it timed out. */
  upstreamStatus: number | null;
  /**
   * How many outbound HTTP requests this attempt made. QA finding QV-09.
   *
   * NOT optional, deliberately. A default of 1 here would silently reproduce the defect:
   * every driver that fans out — six DoH queries per DNS lookup, four RIPEstat endpoints,
   * two Wayback captures plus redirects, an NWS index plus up to twelve zone lookups — would
   * keep recording one, and the table would keep understating our own rate against somebody
   * else's fair-use limit. Every caller states it, and the value comes from a counter at the
   * `fetch` itself rather than from a number a driver declares about itself.
   *
   * Zero for a refusal that made no request, matching `durationMs: 0` on the same rows.
   *
   * ADR 0013 is untouched. It forbids recording WHAT WAS ASKED FOR; this is volume, the same
   * class of fact as `durationMs`.
   */
  upstreamRequests: number;
  /** The raw subject. Hashed here; never stored or logged in this form. */
  subject: string;
  at?: Date;
};

/**
 * Record one outbound attempt.
 *
 * Refusals are logged too — `quotaDenied` and `disabled`, with `duration_ms = 0`, a null
 * status and `upstream_requests = 0` (ADR 0013 §4). A quota denying half its traffic is the single most useful thing
 * this table can tell an operator, and it is invisible if only successful calls are recorded.
 *
 * A failure to write the log never fails the request: the audit entry is an operational
 * record, and losing one is much less bad than turning a working Live surface into a 500.
 * The loss is itself logged.
 */
export async function recordConnectorRequest(entry: AuditEntry): Promise<void> {
  const at = entry.at ?? new Date();
  const expiresAt = new Date(at.getTime() + AUDIT_RETENTION_DAYS * 86_400_000);

  try {
    await db.insert(connectorRequests).values({
      connectorId: entry.connectorId,
      requestedAt: at,
      outcome: entry.outcome,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      upstreamStatus: entry.upstreamStatus,
      upstreamRequests: Math.max(0, Math.round(entry.upstreamRequests)),
      actorKey: hashSubject(entry.subject),
      expiresAt,
    });
  } catch (error) {
    logger.error(
      { scope: "connector.audit", connectorId: entry.connectorId, outcome: entry.outcome, err: error },
      "Failed to write connector audit entry",
    );
  }
}
