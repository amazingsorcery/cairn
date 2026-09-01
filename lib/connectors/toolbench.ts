import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";

import { UpstreamStatusError } from "./runtime";
import type { ConnectorEnvelope } from "./types";

/**
 * JSON decoding and envelope mapping for the four Toolbench network connectors. The HTTP
 * itself has moved to `./upstream.ts` — see the note above the re-export below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO LONGER A `runToolConnector` WRAPPER, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * This module used to export one, because `runConnector` resolved its registry row through
 * `getLiveConnector(driver.kind)` — the first enabled row of that kind — and all of these are
 * `kind = 'infrastructure'`. Resolving by kind would have served one source's row to another
 * source's driver, with the wrong attribution, the wrong quota and the wrong legal basis. The
 * wrapper resolved by slug instead and re-applied the four live checks that passing
 * `options.connector` bypasses.
 *
 * `runConnector` now resolves by `driver.slug` itself, so the wrapper was a second copy of
 * `isLive` maintained in a third place and has been deleted. Call `runConnector` directly.
 *
 * What remains here is the part that is genuinely specific to these four:
 *
 *   `decodeJson`       a body that is not JSON is a shape change, not zero results
 *   `toLookupOutcome`  connector envelope -> the shape a Client Component renders
 *   `invalidInput`     an input WE refused, so no third party is blamed for it
 *
 * `toolbenchActor` was here and has moved to `./actor`. It called `auth()`, which put the
 * whole of next-auth on the import path of every driver — and therefore of
 * `TOOLBENCH_CONNECTOR_SEEDS`, and therefore of `db/seed.ts`, whose test then could not load
 * at all. Seeds are data and must be readable with no request in scope.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER LOGGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The domain, the IP, the URL. ADR 0013: the audit log records *that* a call happened, never
 * *what was asked for*. `connector_requests` has no column that could hold it, and nothing in
 * this file passes a query value to `logger`. A journalist's lookups must not be
 * reconstructable from our own records, and the only reliable way to guarantee that is for
 * the record never to exist.
 */

/* ------------------------------------------------------------------ *
 * The outbound path lives in `./upstream.ts`
 * ------------------------------------------------------------------ */

/**
 * `upstreamGet` and `toolbenchUserAgent` MOVED to `lib/connectors/upstream.ts`, and are
 * re-exported here so the four drivers' imports keep working.
 *
 * The move is QA finding QV-03, reopened. The helper was correct; it was not the only route
 * to the socket. `overpass.ts` and `flights.ts` called `globalThis.fetch` themselves, so
 * neither the byte cap nor the redirect pin applied to them — 513 MiB pulled where the
 * sibling path stops at 5. Putting the primitive in a file of its own makes the invariant
 * statable and therefore testable: `tests/security/outbound-primitive.test.ts` reads every
 * other source file in this directory and fails the build if one of them calls `fetch`.
 *
 * This file is now what its name says: the parts specific to the Toolbench connectors that
 * are not the HTTP itself — JSON decoding, and the envelope the browser renders.
 */
export {
  toolbenchUserAgent,
  upstreamGet,
  upstreamRequest,
  hostOf,
  type UpstreamGetOptions,
  type UpstreamRequestOptions,
  type UpstreamResponse,
} from "./upstream";

/** JSON decode. A body that is not JSON is a shape change, which degrades the tool honestly. */
export function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 502: no usable payload arrived. The parse error is not logged — it quotes the body.
    throw new UpstreamStatusError(502);
  }
}

/* ------------------------------------------------------------------ *
 * Envelope -> what the browser gets
 * ------------------------------------------------------------------ */

/**
 * Map a connector envelope onto the shape a Client Component renders.
 *
 * `reason` passes straight through now that `DegradedReason` and `DEGRADED_REASONS` carry the
 * same six members. It used to be narrowed by hand into a shorter union, which silently
 * collapsed anything unrecognised to `upstream-down` — so the day a new reason was added, the
 * Toolbench would have blamed the upstream for it. `connector-envelope.test.ts` asserts the
 * two lists stay identical.
 *
 * `lastError` is written by `runtime.ts` and is always a sentence we composed — never an
 * upstream body, never a stack, never a URL. That is why it can be returned to the browser
 * verbatim.
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

/**
 * An input we refused. **Nothing was requested**, which is what `bad-request` means and why
 * it is not `upstream-down`: no third party was involved and none should be blamed.
 */
export function invalidInput(message: string): LookupOutcome<never> {
  return { status: "unavailable", reason: "bad-request", message, attribution: null };
}
