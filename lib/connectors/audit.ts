import { connectorRequests, type ConnectorRequestOutcome } from "@/db/schema";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hashSubject } from "@/lib/rate-limit";

/**
 * Outbound audit log: records that a call happened, its cost and outcome — never what was
 * asked for (no path, query, bbox, camera id or body). With a timestamp and actor hash, that
 * content would reconstruct a user's research.
 *
 * The actor is `HMAC-SHA256(subject, RATE_LIMIT_SECRET)`, same as `rate_limits.key`. A DB
 * check requires exactly 64 hex chars, so a raw uuid, email or IP can't be stored.
 */

/** 30 days: enough for a fair-use dispute or a month-over-month error comparison. */
export const AUDIT_RETENTION_DAYS = 30;

export type AuditEntry = {
  connectorId: string;
  outcome: ConnectorRequestOutcome;
  /** Wall-clock cost of the attempt. 0 for `quotaDenied`, `disabled` and a cooldown. */
  durationMs: number;
  /** Upstream HTTP status. Null when no request was made, or when it timed out. */
  upstreamStatus: number | null;
  /**
   * Outbound HTTP requests this attempt made, counted at `fetch`. Required (no default of 1)
   * because drivers fan out. Zero for a refusal that made no request.
   */
  upstreamRequests: number;
  /** The raw subject. Hashed here; never stored or logged in this form. */
  subject: string;
  at?: Date;
};

/**
 * Record one outbound attempt.
 *
 * Refusals (`quotaDenied`, `disabled`) are logged too, with zero duration, null status and
 * zero requests, so operators can see denial rates.
 *
 * A failed write is logged but never fails the request.
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
