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
  /** THEY refused us. Backing off is the fix; our own quota is irrelevant. */
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds?: number }
  /**
   * WE refused ourselves — the connector's global ceiling was already spent.
   *
   * Distinct from `rateLimited` because the two have opposite fixes, and an operator reads
   * this under pressure: `quotaExhausted` means raise our ceiling if the upstream allows it,
   * `rateLimited` means lower it because the upstream does not. Collapsing them is the same
   * conflation that made `quotaDenied` cover both outcomes on the health board until it was
   * split, and the same one behind confidence-versus-reliability and our-record-versus-the-
   * entry. This codebase keeps meeting it; the answer is always to keep them apart.
   */
  | { readonly kind: "quotaExhausted"; readonly resetsAt?: Date }
  /**
   * THEY MOVED, AND WE DO NOT FOLLOW. QA finding QV-18.
   *
   * The upstream answered a 3xx pointing at a different host, and `fetchUpstream` refused it
   * rather than walking it: "the upstream is trustworthy" is exactly the assumption an SSRF
   * exploits, and an open redirect on an otherwise honest service is enough.
   *
   * Its own kind rather than an `upstreamError`, for the reason this union exists at all: an
   * operator reads these under pressure, and "they moved" and "they are down" lead to
   * opposite investigations. A source that has moved is fixed by updating a URL in
   * `lib/sources/<slug>.ts` after checking where it now points; a source that is down is
   * fixed by waiting. Reporting the first as the second sends somebody looking for an outage
   * that is not there.
   *
   * NO PAYLOAD, deliberately. The destination host is upstream-controlled text and would end
   * up rendered; it goes to the structured log (`scope: "source.http"`, `redirectHost`) where
   * an operator can find it and no reader can be shown it.
   */
  | { readonly kind: "redirected" }
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

/**
 * How precisely a feature's coordinate describes where the thing actually is.
 *
 * This is on the FEATURE, not derived per-layer, because it leaks otherwise. The map
 * engineer built a per-layer `precision()` renderer for the weather caveat and then found
 * the hole: a reader can save an NWS alert into a workspace and read a precise-looking
 * coordinate in a PDF export months later, with nothing left to say it is an administrative
 * centroid possibly tens of kilometres from the weather. The export never calls the map's
 * renderer. Carrying it here means the snapshot carries it too.
 *
 * `null` means the coordinate is as exact as the source can make it — and returning `null`
 * for the 1.3% of NWS alerts that do have real geometry matters as much as setting it for
 * the rest, because caveating everything is caveating nothing.
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
  /**
   * Set when the coordinate is an approximation. `null` or absent means it is as exact as
   * the source can make it. Travels with the feature into a workspace snapshot and an
   * export, so the caveat cannot be lost at a boundary the map does not own.
   */
  readonly precision?: PositionalPrecision | null;
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

  /**
   * How long a cached payload may still be shown, past `ttlSeconds`, when the upstream is
   * unreachable — after which the surface shows nothing rather than something wrong.
   *
   * Separate from `ttlSeconds` because they answer different questions: when to refetch, and
   * when to stop believing. A 30-second aircraft feed and a one-hour camera index do not
   * share a horizon, and ADR 0014 §3 requires one. Aircraft positions are worthless within
   * minutes; a camera index is fine for a day.
   */
  readonly staleWhileRevalidateSeconds: number;

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
