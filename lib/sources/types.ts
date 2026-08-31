import type { z } from "zod";

/**
 * The one interface every live source implements.
 *
 * This file is the contract that lets the map and the adapters be built in parallel, and it
 * is the reason **adding a source never requires touching the map component**. If a map
 * component ever needs `if (source === "aircraft")`, this abstraction has failed and the fix
 * belongs here, not there.
 *
 * Product-brief §2b. Adapters return small JSON only — never media. Video and audio URLs are
 * handed to the client to connect to directly, because relaying them through one VPS
 * exhausts its bandwidth in hours and turns a linking site into a rebroadcasting one.
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

/**
 * Attribution is data, not decoration.
 *
 * Returning it from the adapter is what makes it impossible for the UI to forget: a layer
 * cannot render without having been handed the credit its licence requires. Several sources
 * make attribution a condition of use, so a missing line is a licence breach, not a polish
 * defect.
 */
export interface Attribution {
  /** Exact text the licence requires. Rendered at the point of display, not in a footer. */
  readonly text: string;
  /** Where the credit must link, when the licence requires a link. */
  readonly href?: string;
  /** e.g. "CC BY 4.0", "ODbL 1.0", "public domain (US Government)". */
  readonly licence: string;
}

/** Why a layer has no usable data. Every one of these renders a distinct, honest state. */
export type SourceFailure =
  | { readonly kind: "upstreamError"; readonly status?: number; readonly message: string }
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds?: number }
  | { readonly kind: "schemaChanged"; readonly message: string }
  | { readonly kind: "timeout"; readonly afterMs: number }
  | { readonly kind: "notConfigured"; readonly missingEnvVar: string }
  | { readonly kind: "disabled"; readonly reason: string };

/**
 * A fetch either produced features or it did not. It never throws for an expected condition:
 * one bad upstream must disable its own layer and nothing else (product-brief §2b), and an
 * exception crossing a layer boundary is how one source takes down a map.
 */
export type SourceResult<T> =
  | {
      readonly ok: true;
      readonly features: readonly T[];
      /** When the upstream produced this data, not when we cached it. */
      readonly observedAt: Date;
    }
  | { readonly ok: false; readonly failure: SourceFailure; readonly lastGoodAt: Date | null };

/**
 * A result plus the staleness only the cache layer can know.
 *
 * `stale` deliberately does NOT live on `SourceResult`: an adapter has just called upstream,
 * so the only honest value it could ever set is `false`. Whether the caller is looking at a
 * cache entry served past its TTL because the upstream is unreachable is known by the worker
 * holding the Redis key, and nowhere else. Putting the field on the adapter's return would
 * have invited six adapters to each lie about it in the same way.
 */
export interface CachedSourceResult<T> {
  readonly result: SourceResult<T>;
  /** Served past TTL because the upstream could not be reached. */
  readonly stale: boolean;
  /** When this payload was cached, as distinct from when the upstream observed it. */
  readonly cachedAt: Date;
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
  /** Adapter-specific detail, rendered by the feature panel. Never `any`. */
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * What is being asked for. Most sources ignore all of it; viewport-scoped ones do not.
 *
 * This exists so the registry can hold *sources* rather than pre-bound instances of a
 * source. Binding a viewport into the slug at construction time works right up until two
 * viewports are needed, and then the registry is quietly holding two of the same thing.
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
 * adapter is testable without a running Redis and cannot reach for a global.
 */
export interface SourceContext {
  readonly signal: AbortSignal;
  /** Shared, durable side cache. Survives a worker restart; see `fetch`. */
  readonly cache: SourceCache;
  /** Reads a required key and returns `notConfigured` upward rather than throwing. */
  readonly env: (name: string) => string | undefined;
}

/** The narrow slice of a cache an adapter may use. Redis in production, a map in tests. */
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

  /**
   * Cache lifetime in seconds, and the floor on how often we may call upstream.
   * Product-brief §2b: aircraft 5–10s, ships ~30s, quakes ~60s, fires ~15min, webcams ~1h.
   */
  readonly ttlSeconds: number;

  /** Env var holding the key, when one is needed. The key itself never lives in the DB. */
  readonly apiKeyEnvVar?: string;

  /** Zod schema for the raw upstream payload. A parse failure is `schemaChanged`. */
  readonly responseSchema: z.ZodTypeAny;

  /**
   * Map an already-validated upstream payload to features.
   *
   * Separate from `fetch` so it can be tested against a captured fixture with no network —
   * which is the most valuable test an adapter has, because upstream shape changes are the
   * failure this whole layer exists to survive. Capture real payloads; do not invent them.
   */
  normalise(payload: unknown, query: SourceQuery): readonly T[];

  /**
   * Fetch and normalise. Must not throw for an expected failure — return one.
   *
   * `query` carries the viewport for sources that are scoped to one, so a viewport-scoped
   * source can describe itself rather than being baked into the registry as a pre-bound
   * instance. `cache` is the shared store: several adapters need a long-lived side cache
   * (NWS zone centroids, mirror discovery) that must survive a worker restart, and without
   * a handle here each one invents its own in-process map that empties on every deploy.
   */
  fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<T>>;

  /** Cheap liveness probe for the operator dashboard and the deploy health check. */
  healthcheck(ctx: SourceContext): Promise<{ readonly ok: boolean; readonly detail: string }>;
}
