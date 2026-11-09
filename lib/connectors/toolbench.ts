import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";

import { UpstreamStatusError } from "./runtime";
import type { ConnectorEnvelope } from "./types";

/**
 * JSON decoding and envelope mapping for the Toolbench network connectors. Call
 * `runConnector` directly; it resolves the registry row by slug.
 *
 *   `decodeJson`       non-JSON body is a shape change, not zero results
 *   `toLookupOutcome`  connector envelope -> what a Client Component renders
 *   `invalidInput`     an input we refused, so no third party is blamed
 *
 * Never log the queried domain, IP or URL.
 */

/* ------------------------------------------------------------------ *
 * The outbound path lives in `./upstream.ts`
 * ------------------------------------------------------------------ */

/**
 * Re-exported for the drivers' existing imports. `tests/security/outbound-primitive.test.ts`
 * fails if any other file in this directory calls `fetch` directly.
 */
export {
  toolbenchUserAgent,
  upstreamGet,
  upstreamRequest,
  type UpstreamGetOptions,
  type UpstreamRequestOptions,
  type UpstreamResponse,
} from "./upstream";

/** JSON decode; a non-JSON body throws a 502. */
export function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Parse error isn't logged: it quotes the body.
    throw new UpstreamStatusError(502);
  }
}

/* ------------------------------------------------------------------ *
 * Envelope -> what the browser gets
 * ------------------------------------------------------------------ */

/**
 * Map a connector envelope onto the shape a Client Component renders. `reason` passes through
 * (`connector-envelope.test.ts` keeps the two reason lists identical). `lastError` is always
 * our own sentence, so it's safe to return verbatim.
 */
export function toLookupOutcome<T>(envelope: ConnectorEnvelope<T>): LookupOutcome<T> {
  if (envelope.data !== null && envelope.fetchedAt !== null) {
    return {
      status: "ok",
      data: envelope.data,
      fetchedAt: envelope.fetchedAt.toISOString(),
      stale: envelope.state === "stale",
      attribution: envelope.attribution,
      note: envelope.state === "stale" ? envelope.lastError : null,
    };
  }

  return {
    status: "unavailable",
    reason: envelope.reason ?? "upstream-down",
    message: envelope.lastError ?? "This source could not be reached just now.",
    attribution: envelope.attribution,
  };
}

/** An input we refused; nothing was requested upstream. */
export function invalidInput(message: string): LookupOutcome<never> {
  return { status: "unavailable", reason: "bad-request", message, attribution: null };
}
