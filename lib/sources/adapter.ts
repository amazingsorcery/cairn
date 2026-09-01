import type { z } from "zod";

import { decodeJson, fetchUpstream, lastGoodAt, recordGood } from "./http";
import type {
  SourceAdapter,
  SourceContext,
  SourceFailure,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * Shared machinery for poll-model adapters.
 *
 * `types.ts` is the normative contract. This file adds no members to it — the earlier
 * `PollAdapter` extension is gone, because `normalise` now lives on `SourceAdapter` itself.
 * What remains here is the composition every adapter's `fetch` would otherwise repeat: fetch,
 * decode, validate, map, and convert every failure into a typed value rather than a throw.
 *
 * **Where validation happens, and why it matters.** `SourceAdapter.normalise` returns
 * `readonly T[]` with no way to signal failure, so the schema check belongs in `fetch`:
 * `responseSchema.safeParse` decides, and a failure returns `schemaChanged`. `normalise` is
 * then handed an already-validated payload. Each adapter also exposes `normalise` publicly
 * taking `unknown`, so a test can pass a captured fixture straight in — that path re-validates
 * and returns `[]` on a mismatch, which is safe precisely because the *decision* about a shape
 * change is never made there.
 */

/**
 * Run a Zod schema and convert the failure into `schemaChanged`.
 *
 * The Zod message is reduced to failing paths only. The full error embeds the parsed VALUES,
 * and those are upstream-controlled strings that would otherwise reach a log line and an
 * operator's screen.
 */
export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
):
  | { ok: true; data: z.infer<S> }
  | { ok: false; failure: Extract<SourceFailure, { kind: "schemaChanged" }> } {
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
 * The public `normalise` shape: validate, then map. Returns `[]` when the payload does not fit.
 *
 * Used by each adapter to wrap its internal mapper. The empty array is not a lie about "no
 * features" because nothing decides anything from it — `fetch` has already returned
 * `schemaChanged` before reaching here on a real bad payload.
 */
export function normaliseVia<S extends z.ZodTypeAny, T extends SourceFeature>(
  schema: S,
  map: (data: z.infer<S>, query: SourceQuery) => readonly T[],
): (payload: unknown, query: SourceQuery) => readonly T[] {
  return (payload, query) => {
    const parsed = schema.safeParse(payload);
    return parsed.success ? map(parsed.data, query) : [];
  };
}

/**
 * Fetch JSON, validate it, map it, and record the outcome.
 *
 * Every poll adapter's `fetch` is one call to this. It is what makes the contract's promises
 * hold identically everywhere: the cooldown is honoured before the call, a failure is a typed
 * value rather than a throw, and `lastGoodAt` rides along on the failure path so a degraded
 * layer can still say how old the last good data was.
 */
export async function pollJson<S extends z.ZodTypeAny, T extends SourceFeature>(options: {
  readonly slug: string;
  readonly url: string;
  readonly ctx: SourceContext;
  readonly schema: S;
  /** Map validated data to features plus the upstream's own timestamp for the payload. */
  readonly map: (data: z.infer<S>, receivedAt: Date) => {
    readonly features: readonly T[];
    readonly observedAt: Date;
  };
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<SourceResult<T>> {
  const { slug, url, ctx, schema, map } = options;

  const outcome = await fetchUpstream({
    slug,
    url,
    signal: ctx.signal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  if (!outcome.ok) return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(slug) };

  const decoded = decodeJson(outcome.text);
  if (!decoded.ok) return { ok: false, failure: decoded.failure, lastGoodAt: lastGoodAt(slug) };

  const parsed = parseWith(schema, decoded.body);
  if (!parsed.ok) return { ok: false, failure: parsed.failure, lastGoodAt: lastGoodAt(slug) };

  const { features, observedAt } = map(parsed.data, new Date());
  recordGood(slug, observedAt);
  return { ok: true, features, observedAt };
}

/**
 * The standard `healthcheck`: run the real `fetch` and report in one sentence.
 *
 * Deliberately not a HEAD request or a bare 200 check. A source whose schema has changed is
 * *down* for our purposes even though it answers 200, and that is exactly the failure an
 * operator most needs the dashboard to show.
 */
export async function healthcheckByFetch<T extends SourceFeature>(
  adapter: Pick<SourceAdapter<T>, "fetch">,
  ctx: SourceContext,
): Promise<{ ok: boolean; detail: string }> {
  const result = await adapter.fetch({}, ctx);
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
    case "quotaExhausted":
      // Our ceiling, not theirs. An operator reading this must not go looking for a fault
      // at the upstream when the limit is one we set.
      return failure.resetsAt
        ? `our polling budget is spent until ${failure.resetsAt.toISOString()}`
        : "our polling budget for this source is spent";
    case "rateLimited":
      return failure.retryAfterSeconds
        ? `rate limited by the upstream; retrying in ${failure.retryAfterSeconds}s`
        : "rate limited by the upstream";
    case "redirected":
      // Names the event, not the destination: the host is upstream-controlled and is logged
      // rather than rendered. "Refused, not attempted" is the part an operator needs — no
      // second request was made and nothing left the building after the first.
      return "upstream redirected to another host; refused rather than followed";
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

/**
 * Is a feature inside the requested viewport?
 *
 * Applied by adapters whose upstream cannot filter server-side, so `query.bbox` means the same
 * thing on every layer. A source that CAN filter upstream should do that instead — filtering
 * after the fact still pays for the bytes.
 */
export function withinBbox(
  feature: Pick<SourceFeature, "longitude" | "latitude">,
  query: SourceQuery,
): boolean {
  const bbox = query.bbox;
  if (!bbox) return true;
  if (feature.latitude < bbox.south || feature.latitude > bbox.north) return false;
  // A bbox crossing the antimeridian has west > east; the longitude test inverts there.
  return bbox.west <= bbox.east
    ? feature.longitude >= bbox.west && feature.longitude <= bbox.east
    : feature.longitude >= bbox.west || feature.longitude <= bbox.east;
}

/** Apply `query.limit`, where the upstream could not. */
export function applyLimit<T>(features: readonly T[], query: SourceQuery): readonly T[] {
  const limit = query.limit;
  if (limit === undefined || limit < 0 || features.length <= limit) return features;
  return features.slice(0, limit);
}
