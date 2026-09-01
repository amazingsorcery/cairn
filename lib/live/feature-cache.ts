import type { Attribution, SourceFeature, SourceKind } from "@/lib/sources/types";

/**
 * THE SHARED LIVE-PAYLOAD CACHE, AND THE ONLY WAY TO RESOLVE A LIVE FEATURE SERVER-SIDE.
 *
 * ## Why this is in `lib/` and not next to the map route
 *
 * It used to live inside `app/(public)/map/sources.ts`, which was the right home while the
 * map was its only reader. `addWorkspaceItem` is now a second reader: ADR 0025 requires the
 * server, not the client, to be the authority on a saved feature's `attribution`, `licence`,
 * `sourceName` and title, and QA finding QV-14 records what happens otherwise — a snapshot
 * whose fourteen fields all came from a POST body, exported later as though it were sourced
 * evidence. A Server Action cannot import from a route segment without inverting the
 * dependency direction of the whole app, so the cache moved down here and both read it.
 *
 * There is exactly one instance. `app/(public)/map/sources.ts` writes it on every governed
 * poll; nothing else writes it, and `findCachedFeature` never writes and never fetches.
 *
 * ## What a save is allowed to cost
 *
 * NOTHING OUTBOUND. `findCachedFeature` is a read of this process's memory. A save must not
 * be able to originate an upstream request: that would make a signed-in click a second,
 * user-keyed route to a third party, which is precisely the traffic ADR 0011 confines to
 * `pollSource` and the audit log. If the cache has forgotten the feature, the save fails
 * with a sentence saying so (ADR 0025 §Consequences) rather than going to look for it.
 *
 * ## The consequence, stated rather than hidden
 *
 * The cache is per-process and in-memory, so it does not survive a deploy or a restart, and
 * a second web process would not see the first one's entries. A reader who leaves the save
 * picker open across a deploy gets "no longer available" rather than a wrong record. That is
 * the correct failure — ADR 0025 rejects re-fetching precisely because a re-fetch returns
 * the aircraft's *current* position under the original timestamp: not old, but wrong.
 *
 * **This is the shipped arrangement, not a stop-gap.** This comment used to end "when ADR
 * 0019's Redis lands, this file reads that key instead of holding its own map"; ADR 0031
 * removed the `redis` and `worker` containers and recorded the condition under which they
 * would come back, so there is nothing pending (QA finding QV-31). If a shared store ever
 * does land, this file is one of its readers — but a comment promising it, next to code that
 * never gets it, is how a reviewer concludes the restart behaviour above is temporary and
 * stops designing for it.
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
  /** When we cached it, which is a different fact and is kept apart from the one above. */
  readonly cachedAt: Date;
  /**
   * The TTL and credit the **governed poll** returned — the registry row's, not the
   * adapter's constant (ADR 0024). Both must survive a cache hit, or a hit would measure
   * freshness against a number the operator has since changed and would render a layer
   * without the credit its licence requires.
   */
  readonly ttlSeconds: number;
  readonly attribution: Attribution;
}

/**
 * Held on `globalThis` rather than in a module binding.
 *
 * Next's dev server re-evaluates a module on every edit, so a plain `const cache = new Map()`
 * empties on every save — which turns a 60-second TTL into "every keystroke calls USGS". In
 * production it makes no difference; in development it is the difference between respecting
 * an upstream's cadence and hammering it while you work. It is also what lets the map route
 * and the workspace action see the same entries after a hot reload of either one.
 */
const globalForCache = globalThis as typeof globalThis & {
  __cairnMapSourceCache?: Map<string, CachedLayerPayload>;
};

const payloadCache: Map<string, CachedLayerPayload> = (globalForCache.__cairnMapSourceCache ??=
  new Map<string, CachedLayerPayload>());

/**
 * Hard ceiling on distinct entries, so a crafted stream of viewport parameters cannot grow
 * this Map without bound on a small VPS. Eviction is oldest-first, and the whole-degree grid
 * in `normaliseSourceQuery` is the first line of defence: it bounds the key space long before
 * this does. Same construction and same number as `lib/connectors/runtime.ts`.
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

/** Test seam only. Never called on a shipped path. */
export function clearPayloadCache(): void {
  payloadCache.clear();
}

/**
 * One live feature, resolved from what THIS SERVER last held, with the credit that came with
 * it.
 *
 * Everything a `workspace_feature_snapshots` row needs is on here, and none of it passed
 * through a browser.
 */
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
 * Find a feature by `(sourceSlug, featureRef)` — the pair ADR 0025 names — across every
 * cached question this source has answered.
 *
 * ## Why it scans rather than takes a key
 *
 * The cache is keyed `slug:normalisedQuery` (QV-04: one entry per source *and question*, so
 * a reader looking at Europe is never handed Tokyo's aircraft). The save path does not know
 * which viewport the reader's payload came from, and asking the client for it would put a
 * cache key under the client's control — which is the shape of the bug this pair of
 * functions exists to close. So it scans the at-most-256 entries for the slug instead. That
 * is a linear walk over a small map, on a path a human triggers by clicking a button.
 *
 * ## Newest wins
 *
 * Two overlapping viewports can both contain the same aircraft, with observation instants a
 * minute apart. The most recently observed payload is the one the reader was most plausibly
 * looking at, and it is in any case the more truthful record of where the thing is.
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
