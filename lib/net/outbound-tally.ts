import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How many outbound HTTP requests one governed attempt actually made.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — QA finding QV-09
 * ─────────────────────────────────────────────────────────────────────────────
 * `connector_requests` had one row per `runConnector` call, and several drivers make more
 * than one request per call: the DNS driver queries six record types in parallel, RIPEstat
 * four endpoints, the Wayback diff two captures plus any redirect hops, the NWS adapter one
 * index plus up to twelve zone lookups. So the table under-reported outbound volume by 6x on
 * `cloudflare-doh` and 4x on `ripestat` — *in the direction that hides the problem*.
 *
 * That matters more here than it would elsewhere. This table is the artefact that found
 * v1's Q-02: `ok/200 = 140` against `429 = 57` is what proved we were exceeding adsb.lol's
 * documented rate while the connector's own recorded legal basis claimed otherwise. A
 * product whose thesis is that its own records are accurate cannot have its fair-use
 * evidence be wrong by a constant factor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A COUNT DOES NOT BREACH ADR 0013
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR 0013 forbids recording **what was asked for** — no path, no query string, no bounding
 * box, no camera id, no response body — because with a timestamp and even a hashed actor
 * beside it, that reconstructs a journalist's research. A count of outbound HTTP requests is
 * **volume**, not content. It is the same class of fact as `duration_ms`, which the table has
 * always carried: it says how much traffic we generated, and nothing whatsoever about what
 * the traffic was for. Six is six whether the reader looked up `example.com` or their own
 * employer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ASYNC CONTEXT AND NOT A RETURN VALUE
 * ─────────────────────────────────────────────────────────────────────────────
 * A driver could declare "I make six calls", and that number would be right until somebody
 * added a seventh — which is precisely the drift that produced this finding. Counting at the
 * point of the `fetch` itself cannot drift, and it counts the things a declaration would
 * miss: a redirect hop, a per-type failure that was still a request, a discovery call made
 * before the real one.
 *
 * `AsyncLocalStorage` rather than a module-level counter because two attempts can be in
 * flight in the same process at the same time, and a shared counter would credit one
 * reader's requests to the other's audit row. Node core, present in every runtime this code
 * runs on; the connector and source seams are both `nodejs`-runtime, server-only modules.
 */

type Tally = { count: number };

const storage = new AsyncLocalStorage<Tally>();

/**
 * Count one outbound request. A no-op outside a tallied scope, so a healthcheck or a script
 * calling the same HTTP helper costs nothing and needs no special case.
 */
export function countOutboundRequest(): void {
  const tally = storage.getStore();
  if (tally) tally.count += 1;
}

/**
 * Run `fn` with a fresh tally and return its outcome alongside the number of outbound
 * requests made inside it — including inside anything it awaited.
 *
 * The failure branch carries the count too, because a driver that made four requests and
 * then failed made four requests, and an audit row that recorded zero for the attempt that
 * hit the rate limit would be wrong in exactly the direction that hides the problem.
 *
 * Nested scopes are not merged: an inner scope shadows the outer one, which is the correct
 * reading for the one place it could happen (a governed poll calling a governed poll would
 * be a bug, not a nesting).
 */
export async function tallyOutbound<T>(
  fn: () => Promise<T>,
): Promise<
  | { readonly ok: true; readonly value: T; readonly outboundRequests: number }
  | { readonly ok: false; readonly error: unknown; readonly outboundRequests: number }
> {
  const tally: Tally = { count: 0 };
  try {
    const value = await storage.run(tally, fn);
    return { ok: true, value, outboundRequests: tally.count };
  } catch (error) {
    return { ok: false, error, outboundRequests: tally.count };
  }
}
