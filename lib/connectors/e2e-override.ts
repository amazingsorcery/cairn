import type { ConnectorEnvelope, DegradedReason } from "./types";

/**
 * A test-only override that forces a connector into a chosen state without calling upstream.
 *
 * WHY THIS EXISTS. `/live/flights` reads a real third-party aggregator through our own
 * server, so Playwright cannot intercept it: the call happens server-side by design
 * (ADR 0011 §1). Before this hook the E2E suite could only *observe* whatever state the
 * shared connector row happened to be in, and the assertions that need a specific state —
 * ADR 0011 rule 5's four degraded states, and architecture HANDOFF §11 assertion 21, "the
 * stale and unavailable states are reachable in tests, not just theoretically implemented" —
 * had to skip. Coverage that skips is coverage that evaporates exactly when someone changes
 * connector behaviour, which is the moment it was written for.
 *
 * WHY IT CANNOT FIRE IN PRODUCTION. A test hook that a production process can be talked into
 * honouring is a worse defect than the flakiness it removes: an attacker who can set an
 * environment variable could switch a live surface off, or feed a reader fabricated data on a
 * page whose entire value is that its data is real. So:
 *
 *   1. `NODE_ENV === "production"` disables it unconditionally, before the variable is even
 *      read. There is no flag that re-enables it — deliberately, because "unless someone sets
 *      the other variable" is exactly how these things come back.
 *   2. A malformed value is ignored rather than throwing. This must not be able to take a
 *      surface down by being typed wrongly.
 *   3. It returns an envelope. It never suppresses a check, never grants a quota, and never
 *      touches the audit log — it stands in for the whole call, so nothing leaves and nothing
 *      is recorded, which is what the degraded states it simulates would also do.
 *
 * FORMAT — `E2E_CONNECTOR_STATE`, a JSON object keyed by connector slug:
 *
 *   {"adsb-lol": {"reason": "rate-limited"}}     → the degraded state, no outbound call
 *   {"adsb-lol": {"reason": "disabled"}}
 *   {"adsb-lol": {"data": { … }, "ageSeconds": 5}} → a fresh (or stale) payload of your own
 *
 * `data` is passed through as the driver's `Result` without validation, which is acceptable
 * only because this cannot run in production. `ageSeconds` sets how old the payload claims to
 * be, so the `fresh` / `stale` boundary either side of `cache_ttl_seconds` is drivable.
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
};

/**
 * The envelope this connector should return instead of calling out, or `null` to proceed
 * normally — which is always the answer in production.
 */
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
  };
}
