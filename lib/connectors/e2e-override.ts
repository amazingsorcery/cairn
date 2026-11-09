import type { ConnectorEnvelope, DegradedReason } from "./types";

/**
 * A test-only override that forces a connector into a chosen state without calling upstream.
 *
 * Connector calls happen server-side, so Playwright can't intercept them; this lets E2E tests
 * reach the degraded and stale states deterministically.
 *
 * Safety:
 *   1. Always off when `NODE_ENV === "production"`, with no way to re-enable it.
 *   2. A malformed value is ignored rather than throwing.
 *   3. It replaces the whole call: no quota, no audit row, no outbound request.
 *
 * `E2E_CONNECTOR_STATE` is a JSON object keyed by connector slug:
 *
 *   {"adsb-lol": {"reason": "rate-limited"}}     → the degraded state, no outbound call
 *   {"adsb-lol": {"reason": "disabled"}}
 *   {"adsb-lol": {"data": { … }, "ageSeconds": 5}} → a fresh (or stale) payload of your own
 *
 * `data` is passed through unvalidated (test-only). `ageSeconds` backdates the payload.
 */

const VARIABLE = "E2E_CONNECTOR_STATE";

const REASONS: readonly DegradedReason[] = [
  "upstream-down",
  "stale",
  "quota-exhausted",
  "rate-limited",
  "disabled",
];

/** One connector's forced state. */
interface ForcedState {
  reason?: DegradedReason;
  data?: unknown;
  ageSeconds?: number;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(raw: string): Record<string, ForcedState> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const out: Record<string, ForcedState> = {};
  for (const [slug, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue;
    const state: ForcedState = {};
    if (typeof value.reason === "string" && (REASONS as readonly string[]).includes(value.reason)) {
      state.reason = value.reason as DegradedReason;
    }
    if ("data" in value) state.data = value.data;
    if (typeof value.ageSeconds === "number" && Number.isFinite(value.ageSeconds)) {
      state.ageSeconds = value.ageSeconds;
    }
    if (typeof value.message === "string") state.message = value.message;
    if (state.reason === undefined && state.data === undefined) continue;
    out[slug] = state;
  }
  return out;
}

const DEFAULT_MESSAGE: Record<DegradedReason, string> = {
  "upstream-down": "The upstream did not answer. Forced by E2E_CONNECTOR_STATE.",
  stale: "The last payload is past its refresh window. Forced by E2E_CONNECTOR_STATE.",
  "quota-exhausted": "You have reached the limit for this source. Forced by E2E_CONNECTOR_STATE.",
  "rate-limited": "The upstream is rate-limiting us. Forced by E2E_CONNECTOR_STATE.",
  disabled: "This live source is switched off. No request was made.",
  "bad-request": "That request could not be understood. Forced by E2E_CONNECTOR_STATE.",
};

/** The forced envelope for this connector, or `null` (always `null` in production). */
export function e2eOverride<T>(
  slug: string,
  attribution: string | null,
  now: Date = new Date(),
): ConnectorEnvelope<T> | null {
  // Checked first and never conditioned on anything else.
  if (process.env.NODE_ENV === "production") return null;

  const raw = process.env[VARIABLE];
  if (!raw) return null;

  const table = parse(raw);
  const forced = table?.[slug];
  if (!forced) return null;

  if (forced.data !== undefined) {
    const age = forced.ageSeconds ?? 0;
    return {
      fetchedAt: new Date(now.getTime() - age * 1000),
      // `stale` only when asked for explicitly: the caller knows the TTL, this file does not.
      state: forced.reason === "stale" ? "stale" : "fresh",
      data: forced.data as T,
      connectorSlug: slug,
      attribution,
      lastError: forced.reason === "stale" ? (forced.message ?? DEFAULT_MESSAGE.stale) : null,
      reason: forced.reason === "stale" ? "stale" : null,
      // No counter was consulted, so there's no reset time or scope to report.
      quotaResetsAt: null,
      quotaScope: null,
    };
  }

  const reason = forced.reason ?? "upstream-down";
  return {
    fetchedAt: null,
    state: "unavailable",
    data: null,
    connectorSlug: slug,
    attribution,
    lastError: forced.message ?? DEFAULT_MESSAGE[reason],
    reason,
    // Nothing was counted (see above).
    quotaResetsAt: null,
    quotaScope: null,
  };
}
