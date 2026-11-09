import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Counts outbound HTTP requests per governed attempt, for `connector_requests`. Many drivers
 * make several requests per call (DNS queries six record types, RIPEstat four endpoints, etc.).
 *
 * Only a count is recorded, never what was requested: it's volume, like `duration_ms`.
 *
 * Counted at the fetch site (catches redirects and failed sub-requests) using
 * `AsyncLocalStorage` so concurrent attempts don't share a counter.
 */

type Tally = { count: number };

const storage = new AsyncLocalStorage<Tally>();

/** Count one outbound request. No-op outside a tallied scope. */
export function countOutboundRequest(): void {
  const tally = storage.getStore();
  if (tally) tally.count += 1;
}

/**
 * Run `fn` with a fresh tally and return its outcome plus the request count, including on
 * failure. Nested scopes shadow rather than merge.
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
