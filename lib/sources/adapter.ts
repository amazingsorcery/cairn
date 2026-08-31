import type { z } from "zod";

import {
  decodeJson,
  fetchUpstream,
  lastGoodAt,
  recordGood,
  type FetchOptions,
} from "./http";
import type { SourceAdapter, SourceFailure, SourceFeature, SourceResult } from "./types";

/**
 * Shared machinery for poll-model adapters.
 *
 * `types.ts` is the normative contract and is not mine to change. Two small extensions live
 * here instead, and both are proposed additions to it rather than forks of it:
 *
 *  1. **`normalise` is not on `SourceAdapter`.** The brief and ADR 0019 both describe the
 *     interface as `fetch`, `normalise`, `ttl`, `attribution`, `healthcheck`; `types.ts` has
 *     the other four. Without it there is no way to test the parse-and-map step against a
 *     captured payload without a live network call, which is the single most valuable test
 *     these adapters have — it is what catches a shape change. `PollAdapter` below adds it
 *     as a pure function, `unknown` in, features out, no I/O.
 *
 *  2. **`observedAt` comes from the payload.** `SourceResult` documents it as "when the
 *     upstream produced this data, not when we cached it", so it has to be produced by the
 *     same code that reads the payload's own clock. `normalise` returns it.
 *
 * `stale` is always `false` from an adapter: an adapter never serves from cache. Staleness is
 * the caller's concern — the worker holding the Redis entry knows whether it is serving a
 * payload past its TTL; the adapter, which just called upstream, cannot know.
 */

/** The result of turning one raw payload into features. Pure — no I/O, no clock reads. */
export type NormaliseOutcome<T extends SourceFeature> =
  | {
      readonly ok: true;
      readonly features: readonly T[];
      /** The upstream's own timestamp for this payload. Falls back to the receive time. */
      readonly observedAt: Date;
    }
  | {
      readonly ok: false;
      readonly failure: Extract<SourceFailure, { kind: "schemaChanged" }>;
    };

/**
 * `SourceAdapter` plus the pure `normalise` step.
 *
 * Every adapter in this directory is typed as this, so `normalise` can be exercised against
 * a real captured payload in a unit test while `fetch` stays the only thing that touches the
 * network.
 */
export interface PollAdapter<T extends SourceFeature = SourceFeature> extends SourceAdapter<T> {
  /**
   * Validate and map one raw upstream payload. Must never throw: a Zod failure returns
   * `schemaChanged`, which disables this layer and no other.
   */
  normalise(raw: unknown, receivedAt?: Date): NormaliseOutcome<T>;
}

/**
 * Run a Zod schema and convert the failure into `schemaChanged`.
 *
 * The Zod message is summarised to the failing paths only. The full error embeds the parsed
 * VALUES, and those values are an upstream-controlled string that would otherwise reach a
 * log line and an operator screen.
 */
export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; failure: Extract<SourceFailure, { kind: "schemaChanged" }> } {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };

  const paths = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
    .join("; ");
  return {
    ok: false,
    failure: {
      kind: "schemaChanged",
      message: `upstream payload did not match the expected schema (${paths})`,
    },
  };
}

/**
 * Fetch text, decode JSON, normalise, and record the outcome.
 *
 * Every poll adapter's `fetch()` is one call to this. It is what guarantees the promises the
 * contract makes are kept in the same way everywhere: cooldown honoured before the call,
 * typed failure instead of a throw, `lastGoodAt` carried on the failure path so a degraded
 * layer can still say how old the last good data was.
 */
export async function pollJson<T extends SourceFeature>(
  options: FetchOptions & { normalise: (raw: unknown, receivedAt: Date) => NormaliseOutcome<T> },
): Promise<SourceResult<T>> {
  const { normalise, ...fetchOptions } = options;
  const outcome = await fetchUpstream(fetchOptions);
  if (!outcome.ok) return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(options.slug) };

  const decoded = decodeJson(outcome.text);
  if (!decoded.ok) {
    return { ok: false, failure: decoded.failure, lastGoodAt: lastGoodAt(options.slug) };
  }

  const normalised = normalise(decoded.body, new Date());
  if (!normalised.ok) {
    return { ok: false, failure: normalised.failure, lastGoodAt: lastGoodAt(options.slug) };
  }

  recordGood(options.slug, normalised.observedAt);
  return {
    ok: true,
    features: normalised.features,
    observedAt: normalised.observedAt,
    // An adapter never serves from cache; see the note at the top of this file.
    stale: false,
  };
}

/**
 * The standard `healthcheck()`: run the real `fetch` and report in one sentence.
 *
 * Deliberately not a HEAD request or a bare 200 check. A source whose schema has changed is
 * *down* for our purposes even though it answers 200, and that is exactly the failure an
 * operator most needs the dashboard to show.
 */
export async function healthcheckByFetch<T extends SourceFeature>(
  adapter: Pick<SourceAdapter<T>, "slug" | "fetch">,
  signal: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const result = await adapter.fetch(signal);
  if (result.ok) {
    return {
      ok: true,
      detail: `${result.features.length} features, observed ${result.observedAt.toISOString()}`,
    };
  }
  return { ok: false, detail: describeFailure(result.failure) };
}

/** One sentence per failure kind, fit to render. Never an upstream body, stack or URL. */
export function describeFailure(failure: SourceFailure): string {
  switch (failure.kind) {
    case "upstreamError":
      return failure.status
        ? `upstream error (HTTP ${failure.status})`
        : `upstream error: ${failure.message}`;
    case "rateLimited":
      return failure.retryAfterSeconds
        ? `rate limited by the upstream; retrying in ${failure.retryAfterSeconds}s`
        : "rate limited by the upstream";
    case "schemaChanged":
      return `upstream changed shape: ${failure.message}`;
    case "timeout":
      return `upstream did not respond within ${failure.afterMs}ms`;
    case "notConfigured":
      return `not configured: ${failure.missingEnvVar} is unset`;
    case "disabled":
      return `disabled: ${failure.reason}`;
  }
}

/**
 * Finite, in-range coordinates, or null.
 *
 * Returns the narrowed pair rather than a boolean so the caller cannot forget the check and
 * still index into the array. A NaN or out-of-range longitude does not fail loudly — it
 * renders a feature somewhere confidently wrong, which is the worst outcome on a map whose
 * whole claim is that it is accurate.
 */
export function coordinatePair(
  longitude: unknown,
  latitude: unknown,
): { readonly longitude: number; readonly latitude: number } | null {
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { longitude, latitude };
}
