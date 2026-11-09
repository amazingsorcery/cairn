import type { z } from "zod";

/**
 * The interface every live source implements, so adding a source never touches the map
 * component. If the map ever needs `if (source === "aircraft")`, fix it here.
 *
 * Adapters return small JSON, never media; media URLs go to the client directly.
 */

/** What a source is about, which drives default styling and the layer legend grouping. */
export const SOURCE_KINDS = [
  "aircraft",
  "vessels",
  "cameras",
  "earthquakes",
  "wildfires",
  "weather",
  "satellites",
  "disasters",
  "publicSafety",
  "radio",
  "infrastructure",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Attribution, returned by the adapter so a layer can't render without its required credit. */
export interface Attribution {
  /** Exact text the licence requires. Rendered at the point of display, not in a footer. */
  readonly text: string;
  /** Where the credit must link, when the licence requires a link. */
  readonly href?: string;
  /** e.g. "CC BY 4.0", "ODbL 1.0", "public domain (US Government)". */
  readonly licence: string;
}

/** Why a layer has no usable data. Each renders a distinct state. */
export type SourceFailure =
  | { readonly kind: "upstreamError"; readonly status?: number; readonly message: string }
  /** The upstream refused us; back off. */
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds?: number }
  /**
   * Our own global ceiling was spent. Distinct from `rateLimited` because the fixes are
   * opposite (raise our ceiling vs. lower it).
   */
  | { readonly kind: "quotaExhausted"; readonly resetsAt?: Date }
  /**
   * Upstream redirected off its pinned host and we refused to follow (SSRF). Separate from
   * `upstreamError` since "moved" and "down" need different fixes. No payload: the host is
   * upstream-controlled and goes to the log (`redirectHost`) only.
   */
  | { readonly kind: "redirected" }
  | { readonly kind: "schemaChanged"; readonly message: string }
  | { readonly kind: "timeout"; readonly afterMs: number }
  | { readonly kind: "notConfigured"; readonly missingEnvVar: string }
  | { readonly kind: "disabled"; readonly reason: string };

/** Features or a typed failure; never throws for expected conditions, so one bad source can't break the map. */
export type SourceResult<T> =
  | {
      readonly ok: true;
      readonly features: readonly T[];
      /** When the upstream produced this data, not when we cached it. */
      readonly observedAt: Date;
    }
  | { readonly ok: false; readonly failure: SourceFailure; readonly lastGoodAt: Date | null };

/**
 * A result plus staleness, which only the cache layer (`app/(public)/map/sources.ts`) knows;
 * an adapter that just called upstream could only ever say `false`.
 */
export interface CachedSourceResult<T> {
  readonly result: SourceResult<T>;
  /** Served past TTL because the upstream could not be reached. */
  readonly stale: boolean;
  /** When this payload was cached, as distinct from when the upstream observed it. */
  readonly cachedAt: Date;
}

/**
 * How precisely a coordinate locates the thing. Carried on the feature (not per layer) so the
 * caveat survives into workspace snapshots and exports. `null` means as exact as the source
 * allows.
 */
export interface PositionalPrecision {
  /** Short qualifier for a table cell, beside the number it qualifies: "approx · zone centre". */
  readonly label: string;
  /** The full sentence, for a detail panel or an export. Say what the imprecision IS. */
  readonly note: string;
  /** Rough radius of uncertainty in metres, where it can honestly be stated. */
  readonly approximateRadiusMetres?: number;
}

/** A normalised map feature. Every adapter produces this shape, whatever the upstream. */
export interface SourceFeature {
  /** Stable within a source across polls, so the map can track a feature between frames. */
  readonly id: string;
  readonly kind: SourceKind;
  readonly longitude: number;
  readonly latitude: number;
  /** Metres, where the source provides it. */
  readonly altitude?: number;
  /** Short label for the map and the table row. */
  readonly label: string;
  /** Where this feature came from, so a reader can always get back to the origin. */
  readonly sourceUrl?: string;
  /** Set when the coordinate is approximate; null/absent means exact. */
  readonly precision?: PositionalPrecision | null;
  /** Adapter-specific detail, rendered by the feature panel. Never `any`. */
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * What is being asked for. Lets viewport-scoped sources take the viewport per call instead of
 * being pre-bound in the registry.
 */
export interface SourceQuery {
  readonly bbox?: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  /** Cap on features returned, where the upstream supports it. */
  readonly limit?: number;
}

/**
 * Everything an adapter needs from the outside world, passed in rather than imported, so an
 * adapter is testable with a plain map and cannot reach for a global.
 */
export interface SourceContext {
  readonly signal: AbortSignal;
  /**
   * Shared side cache, namespaced by `cacheKey`. Not durable: a per-process `Map`
   * (`app/(public)/map/sources.ts`) that survives polls and hot reloads but not restarts. A
   * miss must be treated as a cold start.
   */
  readonly cache: SourceCache;
  /** Reads a required key and returns `notConfigured` upward rather than throwing. */
  readonly env: (name: string) => string | undefined;
}

/**
 * The cache slice an adapter may use: get/set only, no enumeration or flush. An in-process
 * `Map` today; kept as an interface so a shared store could slot in.
 */
export interface SourceCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export interface SourceAdapter<T extends SourceFeature = SourceFeature> {
  readonly slug: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly homepage: string;
  readonly attribution: Attribution;

  /** Cache lifetime in seconds, and the floor on how often we may call upstream. */
  readonly ttlSeconds: number;

  /**
   * How long past `ttlSeconds` a cached payload may be shown while the upstream is
   * unreachable; after that, show nothing. Varies widely (aircraft: minutes; cameras: days).
   */
  readonly staleWhileRevalidateSeconds: number;

  /** Env var holding the key, when one is needed. The key itself never lives in the DB. */
  readonly apiKeyEnvVar?: string;

  /** Zod schema for the raw upstream payload. A parse failure is `schemaChanged`. */
  readonly responseSchema: z.ZodTypeAny;

  /** Map a validated payload to features. Separate from `fetch` so captured fixtures can be tested offline. */
  normalise(payload: unknown, query: SourceQuery): readonly T[];

  /**
   * Fetch and normalise; return expected failures, don't throw. `ctx.cache` is for long-lived
   * side data (NWS zone centroids, mirror discovery).
   */
  fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<T>>;

  /** Cheap liveness probe for the operator dashboard and the deploy health check. */
  healthcheck(ctx: SourceContext): Promise<{ readonly ok: boolean; readonly detail: string }>;
}
