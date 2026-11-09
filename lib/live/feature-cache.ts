import type { Attribution, SourceFeature, SourceKind } from "@/lib/sources/types";

/**
 * Shared live-payload cache. `app/(public)/map/sources.ts` writes it on each governed poll;
 * `addWorkspaceItem` reads it so a saved feature's attribution, licence and source come from
 * the server, not the request body.
 *
 * `findCachedFeature` never fetches: a save must not trigger an upstream request. If the
 * feature has been evicted the save fails (re-fetching would pair a new position with the
 * old timestamp).
 *
 * In-memory and per-process, so it doesn't survive a restart or span multiple processes.
 */

/** One layer's payload, as the last governed poll produced it. */
export interface CachedLayerPayload {
  readonly sourceSlug: string;
  /** The adapter's display name, so a snapshot reads correctly without a join. */
  readonly sourceName: string;
  readonly sourceKind: SourceKind;
  readonly features: readonly SourceFeature[];
  /** When the UPSTREAM observed this. Never our clock. */
  readonly observedAt: Date;
  /** When we cached it. */
  readonly cachedAt: Date;
  /** TTL and credit from the governed poll (registry row, not the adapter constant). */
  readonly ttlSeconds: number;
  readonly attribution: Attribution;
}

/** On `globalThis` so dev hot-reload doesn't empty the cache and re-hit upstreams. */
const globalForCache = globalThis as typeof globalThis & {
  __cairnMapSourceCache?: Map<string, CachedLayerPayload>;
};

const payloadCache: Map<string, CachedLayerPayload> = (globalForCache.__cairnMapSourceCache ??=
  new Map<string, CachedLayerPayload>());

/**
 * Entry cap with oldest-first eviction, so crafted viewports can't grow the map unboundedly.
 * `normaliseSourceQuery`'s whole-degree grid bounds the key space first.
 */
const MAX_CACHE_ENTRIES = 256;

export function readPayload(key: string): CachedLayerPayload | undefined {
  return payloadCache.get(key);
}

export function writePayload(key: string, entry: CachedLayerPayload): void {
  if (payloadCache.size >= MAX_CACHE_ENTRIES && !payloadCache.has(key)) {
    const oldest = payloadCache.keys().next();
    if (!oldest.done) payloadCache.delete(oldest.value);
  }
  payloadCache.set(key, entry);
}

export function dropPayload(key: string): void {
  payloadCache.delete(key);
}

/** Test-only. */
export function clearPayloadCache(): void {
  payloadCache.clear();
}

/** A live feature resolved from server-side cache, with everything a snapshot row needs. */
export interface ResolvedLiveFeature {
  readonly sourceSlug: string;
  readonly sourceName: string;
  readonly sourceKind: SourceKind;
  readonly feature: SourceFeature;
  /** The upstream's observation instant for the payload this feature arrived in. */
  readonly observedAt: Date;
  readonly attribution: Attribution;
}

/**
 * Find a feature by `(sourceSlug, featureRef)` across all cached queries for the source.
 * Scans (at most 256 entries) rather than taking a cache key from the client. If several
 * entries contain it, the most recently observed wins.
 */
export function findCachedFeature(
  sourceSlug: string,
  featureRef: string,
): ResolvedLiveFeature | null {
  let best: ResolvedLiveFeature | null = null;

  for (const entry of payloadCache.values()) {
    if (entry.sourceSlug !== sourceSlug) continue;
    if (best !== null && entry.observedAt.getTime() <= best.observedAt.getTime()) continue;

    const feature = entry.features.find((candidate) => candidate.id === featureRef);
    if (!feature) continue;

    best = {
      sourceSlug: entry.sourceSlug,
      sourceName: entry.sourceName,
      sourceKind: entry.sourceKind,
      feature,
      observedAt: entry.observedAt,
      attribution: entry.attribution,
    };
  }

  return best;
}
